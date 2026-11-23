import { randomUUID } from "node:crypto";
import { UUID, MongoServerError } from "mongodb";

import { client } from "../../config/db.js";
import { env } from "../../config/env.js";
import { getStripeClient } from "../../config/stripe.js";
import type Stripe from "stripe";

interface VendorDocument {
  _id: UUID;
  name: string;
  email: string;
  role: string;
  isBlocked: boolean;
  subscriptionPlan?: "free" | "premium";
  subscriptionExpiresAt?: Date | null;
  stripeSubscriptionId?: string | null;
  subscriptionPaymentStatus?: "paid" | "payment_failed";
  subscriptionPaymentFailedAt?: Date | null;
}

interface TransactionDocument {
  vendorId: UUID;
  plan: "premium";
  amount: number;
  currency: string;
  stripeSessionId: string;
  stripeSubscriptionId?: string;
  status: "pending" | "paid" | "failed" | "cancelled";
  createdAt: Date;
}

interface CheckoutLockDocument {
  _id: string;
  attemptId: string;
  createdAt: Date;
}

type StripeEvent = Stripe.Event;
type StripeSubscription = Stripe.Subscription;
type StripeCheckoutSession = Stripe.Checkout.Session;

// ==========================================
// CUSTOM ERROR
// ==========================================

export class SubscriptionServiceError extends Error {
  constructor(
    message: string,
    public statusCode: 400 | 403 | 404 | 409 | 500
  ) {
    super(message);
    this.name = "SubscriptionServiceError";
  }
}

// ==========================================
// DATABASE COLLECTIONS
// ==========================================

const getUsersCollection = () =>
  client.db(env.DB_NAME)
    .collection<VendorDocument>("user");

const getTransactionsCollection = () =>
  client.db(env.DB_NAME)
    .collection<TransactionDocument>("transactions");

const getCheckoutLocksCollection = () =>
  client.db(env.DB_NAME)
    .collection<CheckoutLockDocument>("checkoutLocks");

// ==========================================
// HELPER FUNCTIONS
// ==========================================

const getVendorObjectId = (vendorId: string): UUID => {
  try {
    return new UUID(vendorId);
  } catch {
    throw new Error("Invalid vendor ID in Stripe metadata.");
  }
};

const getSubscriptionPeriodEnd = (
  subscription: StripeSubscription
): Date => {
  const periodEnd =
    subscription.items.data[0]?.current_period_end;

  if (!periodEnd) {
    throw new Error(
      "Stripe subscription period end is unavailable."
    );
  }

  return new Date(periodEnd * 1000);
};

const isSubscriptionActive = (
  subscription: StripeSubscription
): boolean => {
  return ["active", "trialing"].includes(subscription.status);
};

const hasActivePremium = (
  vendor: VendorDocument
): boolean => {
  return (
    vendor.subscriptionPlan === "premium" &&
    vendor.subscriptionExpiresAt instanceof Date &&
    vendor.subscriptionExpiresAt.getTime() > Date.now()
  );
};

const getEligibleVendor = async (
  vendorObjectId: UUID
): Promise<VendorDocument> => {
  const vendor = await getUsersCollection().findOne({
    _id: vendorObjectId,
  });

  if (!vendor) {
    throw new SubscriptionServiceError(
      "Vendor account not found.",
      404
    );
  }

  if (vendor.role !== "vendor") {
    throw new SubscriptionServiceError(
      "Only vendors can purchase Premium subscriptions.",
      403
    );
  }

  if (vendor.isBlocked) {
    throw new SubscriptionServiceError(
      "Blocked vendors cannot purchase subscriptions.",
      403
    );
  }

  if (hasActivePremium(vendor)) {
    throw new SubscriptionServiceError(
      "Your Premium subscription is already active.",
      409
    );
  }

  return vendor;
};

// ==========================================
// DATABASE INDEXES
// ==========================================

export const ensureSubscriptionIndexes =
  async (): Promise<void> => {
    const transactions = getTransactionsCollection();

    await transactions.createIndex(
      { stripeSessionId: 1 },
      {
        unique: true,
        name: "unique_stripe_session",
      }
    );

    await transactions.createIndex(
      { vendorId: 1, createdAt: -1 },
      {
        name: "vendor_transactions",
      }
    );

    await transactions.createIndex(
      { stripeSubscriptionId: 1 },
      {
        sparse: true,
        name: "stripe_subscription",
      }
    );

    await transactions.createIndex(
      { vendorId: 1, status: 1 },
      {
        name: "vendor_transaction_status",
      }
    );
  };

// ==========================================
// CHECKOUT LOCK
// ==========================================

const CHECKOUT_LOCK_STALE_MS = 15 * 60 * 1000;

const acquireCheckoutLock = async (
  vendorId: string,
  attemptId: string
): Promise<string> => {
  const locks = getCheckoutLocksCollection();

  try {
    await locks.insertOne({
      _id: vendorId,
      attemptId,
      createdAt: new Date(),
    });

    return attemptId;
  } catch (error) {
    if (
      error instanceof MongoServerError &&
      error.code === 11000
    ) {
      // Recover an abandoned lock while preserving its
      // original Stripe idempotency key.
      const recovered = await locks.updateOne(
        {
          _id: vendorId,
          createdAt: {
            $lt: new Date(Date.now() - CHECKOUT_LOCK_STALE_MS),
          },
        },
        {
          $set: {
            createdAt: new Date(),
          },
        }
      );

      if (recovered.modifiedCount === 1) {
        const existingLock = await locks.findOne({
          _id: vendorId,
        });

        if (existingLock) {
          return existingLock.attemptId;
        }
      }

      throw new SubscriptionServiceError(
        "A checkout request is already being processed.",
        409
      );
    }

    throw error;
  }
};

const releaseCheckoutLock = async (
  vendorId: string,
  attemptId: string
): Promise<void> => {
  await getCheckoutLocksCollection().deleteOne({
    _id: vendorId,
    attemptId,
  });
};

// ==========================================
// CHECK EXISTING CHECKOUT SESSIONS
// ==========================================

const findExistingCheckout = async (
  vendorObjectId: UUID
): Promise<{
  url: string;
  sessionId: string;
} | null> => {
  const stripe = getStripeClient();

  const pendingTransactions =
    await getTransactionsCollection()
      .find({
        vendorId: vendorObjectId,
        plan: "premium",
        status: "pending",
      })
      .sort({ createdAt: -1 })
      .toArray();

  let existingCheckout: {
    url: string;
    sessionId: string;
  } | null = null;

  for (const transaction of pendingTransactions) {
    const session =
      await stripe.checkout.sessions.retrieve(
        transaction.stripeSessionId
      );

    if (session.status === "expired") {
      await getTransactionsCollection().updateOne(
        {
          stripeSessionId: session.id,
          vendorId: vendorObjectId,
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
          },
        }
      );

      continue;
    }

    if (session.status === "complete") {
      throw new SubscriptionServiceError(
        "Your previous checkout is awaiting subscription verification.",
        409
      );
    }

    if (session.status === "open" && session.url) {
      existingCheckout ??= {
        url: session.url,
        sessionId: session.id,
      };

      continue;
    }

    throw new SubscriptionServiceError(
      "An existing checkout could not be verified.",
      409
    );
  }

  return existingCheckout;
};

// ==========================================
// CREATE PREMIUM CHECKOUT SESSION
// ==========================================

export const createPremiumCheckoutSession = async (
  vendorId: string
): Promise<{
  url: string;
  sessionId: string;
}> => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) {
    throw new SubscriptionServiceError(
      "Stripe is not configured. Please try again later.",
      500
    );
  }

  let vendorObjectId: UUID;

  try {
    vendorObjectId = new UUID(vendorId);
  } catch {
    throw new SubscriptionServiceError(
      "Invalid vendor account.",
      400
    );
  }

  await getEligibleVendor(vendorObjectId);

  const lockId = vendorObjectId.toString();
  const attemptId = await acquireCheckoutLock(
    lockId,
    randomUUID()
  );

  let safeToReleaseLock = true;

  try {
    const existingCheckout =
      await findExistingCheckout(vendorObjectId);

    const vendor = await getEligibleVendor(
      vendorObjectId
    );

    if (existingCheckout) {
      return existingCheckout;
    }

    const stripe = getStripeClient();

    const price = await stripe.prices.retrieve(
      env.STRIPE_PRICE_ID
    );

    if (
      !price.active ||
      !price.recurring ||
      price.unit_amount === null
    ) {
      throw new SubscriptionServiceError(
        "The configured Stripe Price must be an active recurring price.",
        400
      );
    }

    // Keep the lock if the Stripe request has
    // an uncertain outcome.

    safeToReleaseLock = false;

    const session =
      await stripe.checkout.sessions.create(
        {
          mode: "subscription",

          customer_email: vendor.email,

          client_reference_id: vendorId,

          line_items: [
            {
              price: env.STRIPE_PRICE_ID,
              quantity: 1,
            },
          ],

          metadata: {
            vendorId,
            plan: "premium",
          },

          subscription_data: {
            metadata: {
              vendorId,
              plan: "premium",
            },
          },

          success_url:
            `${env.CLIENT_URL}/payment/success` +
            "?session_id={CHECKOUT_SESSION_ID}",

          cancel_url:
            `${env.CLIENT_URL}/payment/cancel`,
        },

        {
          idempotencyKey:
            `pizzahub-checkout-${attemptId}`,
        }
      );

    try {
      if (!session.url) {
        throw new SubscriptionServiceError(
          "Unable to create the Stripe Checkout URL.",
          500
        );
      }

      await getTransactionsCollection().insertOne({
        vendorId: vendorObjectId,
        plan: "premium",
        amount: price.unit_amount,
        currency: price.currency,
        stripeSessionId: session.id,
        status: "pending",
        createdAt: new Date(),
      });

      safeToReleaseLock = true;

      return {
        url: session.url,
        sessionId: session.id,
      };

    } catch (error) {
      // Expire the session if saving it fails.

      try {
        const expiredSession =
          await stripe.checkout.sessions.expire(
            session.id
          );

        if (expiredSession.status === "expired") {
          safeToReleaseLock = true;
        }

      } catch (expireError) {
        console.error(
          "Unable to safely expire checkout:",
          expireError
        );
      }

      throw error;
    }

  } finally {
    if (safeToReleaseLock) {
      await releaseCheckoutLock(
        lockId,
        attemptId
      );
    } else {
      console.error(
        "Checkout requires reconciliation:",
        { vendorId, attemptId }
      );
    }
  }
};

// ==========================================
// CHECKOUT COMPLETED WEBHOOK
// ==========================================

const handleCheckoutCompleted = async (
  session: StripeCheckoutSession
): Promise<void> => {
  if (
    session.mode !== "subscription" ||
    !session.subscription
  ) {
    return;
  }

  const vendorId = session.metadata?.vendorId;

  if (
    !vendorId ||
    session.client_reference_id !== vendorId ||
    session.metadata?.plan !== "premium"
  ) {
    throw new Error(
      "Invalid vendor metadata in Stripe Checkout Session."
    );
  }

  const vendorObjectId =
    getVendorObjectId(vendorId);

  const transaction =
    await getTransactionsCollection().findOne({
      stripeSessionId: session.id,
      vendorId: vendorObjectId,
      plan: "premium",

      status: {
        $in: ["pending", "paid"],
      },
    });

  if (!transaction) {
    throw new Error(
      "Verified subscription transaction was not found."
    );
  }

  if (
    session.payment_status !== "paid" &&
    session.payment_status !== "no_payment_required"
  ) {
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;

  const stripe = getStripeClient();

  const subscription =
    await stripe.subscriptions.retrieve(
      subscriptionId
    );

  if (
    subscription.metadata?.vendorId !== vendorId ||
    subscription.metadata?.plan !== "premium"
  ) {
    throw new Error(
      "Stripe Subscription metadata does not match the Checkout Session."
    );
  }

  if (
    !env.STRIPE_PRICE_ID ||
    !subscription.items.data.some(
      item => item.price.id === env.STRIPE_PRICE_ID
    )
  ) {
    throw new Error(
      "Stripe Subscription does not contain the configured Premium price."
    );
  }

  if (!isSubscriptionActive(subscription)) {
    return;
  }

  const expiresAt =
    getSubscriptionPeriodEnd(subscription);

  const newerPaidTransaction =
    await getTransactionsCollection().findOne({
      vendorId: vendorObjectId,
      plan: "premium",
      status: "paid",

      createdAt: {
        $gt: transaction.createdAt,
      },
    });

  if (newerPaidTransaction) {
    return;
  }

  const mongoSession = client.startSession();

  try {
    await mongoSession.withTransaction(
      async () => {
        const newerPaidTransaction =
          await getTransactionsCollection().findOne(
            {
              vendorId: vendorObjectId,
              plan: "premium",
              status: "paid",

              createdAt: {
                $gt: transaction.createdAt,
              },
            },
            {
              session: mongoSession,
            }
          );

        if (newerPaidTransaction) {
          return;
        }

        const transactionResult =
          await getTransactionsCollection().updateOne(
            {
              stripeSessionId: session.id,
              vendorId: vendorObjectId,

              status: {
                $in: ["pending", "paid"],
              },
            },

            {
              $set: {
                status: "paid",
                stripeSubscriptionId: subscriptionId,
              },
            },

            {
              session: mongoSession,
            }
          );

        if (transactionResult.matchedCount !== 1) {
          throw new Error(
            "Subscription transaction could not be verified."
          );
        }

        const vendorResult =
          await getUsersCollection().updateOne(
            {
              _id: vendorObjectId,
              role: "vendor",
              isBlocked: false,
            },

            {
              $set: {
                subscriptionPlan: "premium",
                subscriptionExpiresAt: expiresAt,
                stripeSubscriptionId: subscriptionId,
                subscriptionPaymentStatus: "paid",
                subscriptionPaymentFailedAt: null,
              },
            },

            {
              session: mongoSession,
            }
          );

        if (vendorResult.matchedCount !== 1) {
          throw new Error(
            "Eligible vendor account was not found."
          );
        }
      },

      {
        readConcern: {
          level: "snapshot",
        },

        writeConcern: {
          w: "majority",
        },

        readPreference: "primary",
      }
    );

  } finally {
    await mongoSession.endSession();
  }
};

// ==========================================
// SUBSCRIPTION LIFECYCLE
// ==========================================

const handleSubscriptionUpdated = async (
  subscription: StripeSubscription,
  eventType: StripeEvent["type"]
): Promise<void> => {
  const vendorId =
    subscription.metadata?.vendorId;

  if (
    !vendorId ||
    subscription.metadata?.plan !== "premium"
  ) {
    throw new Error(
      "Invalid vendor metadata in Stripe Subscription."
    );
  }

  const vendorObjectId =
    getVendorObjectId(vendorId);

  const transaction =
    await getTransactionsCollection().findOne({
      vendorId: vendorObjectId,
      stripeSubscriptionId: subscription.id,
      plan: "premium",
      status: "paid",
    });

  if (!transaction) {
    throw new Error(
      "Verified subscription transaction was not found. Stripe webhook will retry."
    );
  }

  const isActive =
    eventType === "customer.subscription.updated" &&
    isSubscriptionActive(subscription);

  // Keep the previously paid access period during
  // a temporary renewal payment failure.

  if (
    eventType === "customer.subscription.updated" &&
    subscription.status === "past_due"
  ) {
    return;
  }

  if (isActive) {
    const stripe = getStripeClient();

    const liveSubscription =
      await stripe.subscriptions.retrieve(
        subscription.id
      );

    if (!isSubscriptionActive(liveSubscription)) {
      return;
    }

    const latestInvoice =
      liveSubscription.latest_invoice;

    const latestInvoiceId =
      typeof latestInvoice === "string"
        ? latestInvoice
        : latestInvoice?.id;

    if (
      liveSubscription.status === "active" &&
      latestInvoiceId
    ) {
      const invoice = await stripe.invoices.retrieve(
        latestInvoiceId
      );

      if (invoice.status !== "paid") {
        return;
      }
    }

    const expiresAt =
      getSubscriptionPeriodEnd(liveSubscription);

    await getUsersCollection().updateOne(
      {
        _id: vendorObjectId,
        role: "vendor",
        isBlocked: false,
        stripeSubscriptionId: subscription.id,
      },

      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionExpiresAt: expiresAt,
        },
      }
    );

    return;
  }

  const shouldRevokePremium =
    eventType === "customer.subscription.deleted" ||
    (
      eventType === "customer.subscription.updated" &&
      [
        "canceled",
        "unpaid",
        "incomplete_expired",
        "paused",
      ].includes(subscription.status)
    );

  // Do not revoke Premium for temporary or unknown states.
  if (!shouldRevokePremium) {
    return;
  }

  await getUsersCollection().updateOne(
    {
      _id: vendorObjectId,
      role: "vendor",
      stripeSubscriptionId: subscription.id,
    },

    {
      $set: {
        subscriptionPlan: "free",
        subscriptionExpiresAt: null,
      },

      $unset: {
        stripeSubscriptionId: "",
      },
    }
  );
};

// ==========================================
// INVOICE LIFECYCLE
// ==========================================

type StripeInvoice = Stripe.Invoice;

const getInvoiceSubscriptionId = (
  invoice: StripeInvoice
): string | null => {
  const value =
    invoice.parent?.subscription_details?.subscription;

  if (!value) return null;

  return typeof value === "string"
    ? value
    : value.id;
};

const getLatestInvoiceId = (
  subscription: StripeSubscription
): string | null => {
  const value = subscription.latest_invoice;

  if (!value) return null;

  return typeof value === "string"
    ? value
    : value.id;
};

const handleRenewalInvoice = async (
  eventInvoice: StripeInvoice,
  paidEvent: boolean
): Promise<void> => {

  // Initial purchase is processed separately by
  // checkout.session.completed.

  if (
    eventInvoice.billing_reason !==
    "subscription_cycle"
  ) {
    return;
  }

  const subscriptionId =
    getInvoiceSubscriptionId(eventInvoice);

  if (!subscriptionId) return;

  const stripe = getStripeClient();

  // Always retrieve current Stripe state.
  // Never trust only an old event snapshot.

  const [invoice, subscription] =
    await Promise.all([
      stripe.invoices.retrieve(eventInvoice.id),
      stripe.subscriptions.retrieve(subscriptionId),
    ]);

  if (
    getInvoiceSubscriptionId(invoice) !==
      subscription.id ||
    getLatestInvoiceId(subscription) !==
      invoice.id
  ) {
    return;
  }

  const vendorId =
    subscription.metadata?.vendorId;

  if (
    !vendorId ||
    subscription.metadata?.plan !== "premium"
  ) {
    throw new Error(
      "Invalid subscription metadata."
    );
  }

  if (
    !env.STRIPE_PRICE_ID ||
    !subscription.items.data.some(
      item => item.price.id === env.STRIPE_PRICE_ID
    )
  ) {
    throw new Error(
      "Unexpected subscription price."
    );
  }

  const vendorObjectId =
    getVendorObjectId(vendorId);

  // Only recognize subscriptions established by
  // an already verified checkout transaction.

  const transaction =
    await getTransactionsCollection().findOne({
      vendorId: vendorObjectId,
      stripeSubscriptionId: subscription.id,
      plan: "premium",
      status: "paid",
    });

  if (!transaction) {
    throw new Error(
      "Verified subscription transaction was not found. Stripe webhook will retry."
    );
  }

  const vendorFilter = {
    _id: vendorObjectId,
    role: "vendor",
    isBlocked: false,
    stripeSubscriptionId: subscription.id,
  };

  if (paidEvent) {

    if (
      invoice.status !== "paid" ||
      subscription.status !== "active"
    ) {
      return;
    }

    const expiresAt =
      getSubscriptionPeriodEnd(subscription);

    await getUsersCollection().updateOne(
      vendorFilter,
      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionPaymentStatus: "paid",
          subscriptionPaymentFailedAt: null,
        },
        $max: {
          subscriptionExpiresAt: expiresAt,
        },
      }
    );

    console.log(
      "Verified subscription renewal:",
      invoice.id
    );

    return;
  }

  // A failed renewal must not erase the
  // previous successfully paid access period.

  if (invoice.status === "paid") {
    return;
  }

  await getUsersCollection().updateOne(
    vendorFilter,
    {
      $set: {
        subscriptionPaymentStatus: "payment_failed",
        subscriptionPaymentFailedAt: new Date(),
      },
    }
  );

  console.warn(
    "Subscription renewal payment failed:",
    invoice.id
  );
};

// ==========================================
// CHECKOUT SESSION FAILURE / EXPIRATION
// ==========================================

const handleCheckoutSessionTerminal = async (
  session: StripeCheckoutSession,
  status: "failed" | "cancelled"
): Promise<void> => {
  // Only vendor Premium subscription sessions belong here.
  if (session.mode !== "subscription") return;

  const vendorId = session.metadata?.vendorId;

  if (
    !vendorId ||
    session.client_reference_id !== vendorId ||
    session.metadata?.plan !== "premium"
  ) {
    throw new Error(
      "Invalid vendor metadata in Stripe Checkout Session."
    );
  }

  const vendorObjectId = getVendorObjectId(vendorId);
  const transactions = getTransactionsCollection();

  const transaction = await transactions.findOne({
    stripeSessionId: session.id,
    vendorId: vendorObjectId,
    plan: "premium",
  });

  if (!transaction) {
    // Return 5xx through the webhook controller so Stripe retries.
    throw new Error(
      "Checkout transaction was not found for terminal event."
    );
  }

  // Never let a delayed failure/expiration event overwrite a paid transaction.
  if (transaction.status !== "pending") return;

  await transactions.updateOne(
    {
      stripeSessionId: session.id,
      vendorId: vendorObjectId,
      plan: "premium",
      status: "pending",
    },
    {
      $set: { status },
    }
  );
};

// ==========================================
// STRIPE WEBHOOK ROUTING
// ==========================================

export const handleSubscriptionWebhook = async (
  event: StripeEvent
): Promise<void> => {
  switch (event.type) {
    case "invoice.paid": {
      await handleRenewalInvoice(
        event.data.object as StripeInvoice,
        true
      );
      return;
    }

    case "invoice.payment_failed": {
      await handleRenewalInvoice(
        event.data.object as StripeInvoice,
        false
      );
      return;
    }

    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session =
        event.data.object as StripeCheckoutSession;

      await handleCheckoutCompleted(session);

      return;
    }

    case "checkout.session.async_payment_failed": {
      const session =
        event.data.object as StripeCheckoutSession;

      await handleCheckoutSessionTerminal(
        session,
        "failed"
      );

      return;
    }

    case "checkout.session.expired": {
      const session =
        event.data.object as StripeCheckoutSession;

      await handleCheckoutSessionTerminal(
        session,
        "cancelled"
      );

      return;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription =
        event.data.object as StripeSubscription;

      await handleSubscriptionUpdated(
        subscription,
        event.type
      );

      return;
    }

    default: {
      return;
    }
  }
};