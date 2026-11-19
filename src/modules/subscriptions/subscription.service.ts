import { randomUUID } from "node:crypto";
import { UUID } from "mongodb";

import { client } from "../../config/db.js";
import { env } from "../../config/env.js";
import { getStripeClient } from "../../config/stripe.js";

type StripeSubscription = import("stripe").default.Subscription;
type StripeEvent = import("stripe").default.Event;

interface VendorDocument {
  _id: UUID;
  name: string;
  email: string;
  role: string;
  isBlocked: boolean;
  subscriptionPlan?: "free" | "premium";
  subscriptionExpiresAt?: Date | null;
  stripeSubscriptionId?: string;
  checkoutLockId?: string;
  checkoutLockUntil?: Date;
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

export class SubscriptionServiceError extends Error {
  constructor(
    message: string,
    public statusCode: 400 | 403 | 404 | 409 | 500
  ) {
    super(message);
    this.name = "SubscriptionServiceError";
  }
}

const getUsersCollection = () =>
  client.db(env.DB_NAME).collection<VendorDocument>("user");

const getTransactionsCollection = () =>
  client.db(env.DB_NAME).collection<TransactionDocument>("transactions");

const CHECKOUT_LOCK_DURATION_MS = 5 * 60 * 1000;

const parseVendorId = (vendorId: string): UUID => {
  try {
    return new UUID(vendorId);
  } catch {
    throw new Error("Invalid vendor ID in Stripe metadata.");
  }
};

export const ensureSubscriptionIndexes = async (): Promise<void> => {
  const transactions = getTransactionsCollection();

  await transactions.createIndex(
    { stripeSessionId: 1 },
    { unique: true, name: "unique_stripe_session" }
  );

  await transactions.createIndex(
    { vendorId: 1, createdAt: -1 },
    { name: "vendor_transactions" }
  );

  await transactions.createIndex(
    { stripeSubscriptionId: 1 },
    {
      name: "stripe_subscription_lookup",
      partialFilterExpression: {
        stripeSubscriptionId: { $exists: true },
      },
    }
  );
};

export const createPremiumCheckoutSession = async (
  vendorId: string
): Promise<{ url: string; sessionId: string }> => {
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

  const users = getUsersCollection();
  const transactions = getTransactionsCollection();

  const vendor = await users.findOne({
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

  const lockId = randomUUID();
  const now = new Date();

  const lockResult = await users.updateOne(
    {
      _id: vendorObjectId,
      role: "vendor",
      isBlocked: { $ne: true },
      $or: [
        { checkoutLockUntil: { $exists: false } },
        { checkoutLockUntil: { $lte: now } },
        { checkoutLockUntil: { $type: "null" } },
      ],
    },
    {
      $set: {
        checkoutLockId: lockId,
        checkoutLockUntil: new Date(
          now.getTime() + CHECKOUT_LOCK_DURATION_MS
        ),
      },
    }
  );

  if (lockResult.matchedCount !== 1) {
    throw new SubscriptionServiceError(
      "Another checkout request is already being processed. Please try again shortly.",
      409
    );
  }

  try {
    const currentVendor = await users.findOne({
      _id: vendorObjectId,
      role: "vendor",
    });

    if (!currentVendor) {
      throw new SubscriptionServiceError(
        "Vendor account not found.",
        404
      );
    }

    if (currentVendor.isBlocked) {
      throw new SubscriptionServiceError(
        "Blocked vendors cannot purchase subscriptions.",
        403
      );
    }

    const hasActivePremium =
      currentVendor.subscriptionPlan === "premium" &&
      currentVendor.subscriptionExpiresAt instanceof Date &&
      currentVendor.subscriptionExpiresAt.getTime() > Date.now();

    if (hasActivePremium) {
      throw new SubscriptionServiceError(
        "Your Premium subscription is already active.",
        409
      );
    }

    const stripe = getStripeClient();

    const pendingTransaction = await transactions.findOne(
      {
        vendorId: vendorObjectId,
        plan: "premium",
        status: "pending",
      },
      {
        sort: { createdAt: -1 },
      }
    );

    if (pendingTransaction) {
      const existingSession =
        await stripe.checkout.sessions.retrieve(
          pendingTransaction.stripeSessionId
        );

      if (
        existingSession.status === "open" &&
        existingSession.url
      ) {
        return {
          url: existingSession.url,
          sessionId: existingSession.id,
        };
      }

      if (existingSession.status === "expired") {
        await transactions.updateOne(
          {
            stripeSessionId: existingSession.id,
            status: "pending",
          },
          {
            $set: {
              status: "cancelled",
            },
          }
        );
      } else {
        throw new SubscriptionServiceError(
          "Your previous checkout is being processed. Please wait before trying again.",
          409
        );
      }
    }

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

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: currentVendor.email,
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

      success_url: `${env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.CLIENT_URL}/payment/cancel`,
    });

    if (!session.url) {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch {
        // Preserve the original error.
      }

      throw new SubscriptionServiceError(
        "Unable to create the Stripe Checkout URL.",
        500
      );
    }

    try {
      await transactions.insertOne({
        vendorId: vendorObjectId,
        plan: "premium",
        amount: price.unit_amount,
        currency: price.currency,
        stripeSessionId: session.id,
        status: "pending",
        createdAt: new Date(),
      });
    } catch (error) {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch {
        // Preserve the original database error.
      }

      throw error;
    }

    return {
      url: session.url,
      sessionId: session.id,
    };
  } finally {
    try {
      await users.updateOne(
        {
          _id: vendorObjectId,
          checkoutLockId: lockId,
        },
        {
          $unset: {
            checkoutLockId: "",
            checkoutLockUntil: "",
          },
        }
      );
    } catch {
      // The lock expires automatically as a fallback.
    }
  }
};

const handleCheckoutCompleted = async (
  event: StripeEvent
): Promise<void> => {
  const stripe = getStripeClient();
  const session = event.data.object as import("stripe").default.Checkout.Session;

  if (session.mode !== "subscription" || !session.subscription) {
    return;
  }

  const vendorId = session.metadata?.vendorId;

  if (
    !vendorId ||
    session.client_reference_id !== vendorId ||
    session.metadata?.plan !== "premium"
  ) {
    throw new Error("Invalid vendor metadata in Stripe Checkout Session.");
  }

  const vendorObjectId = parseVendorId(vendorId);

  const transactions = getTransactionsCollection();

  const existingTransaction = await transactions.findOne({
    stripeSessionId: session.id,
    vendorId: vendorObjectId,
    plan: "premium",
    status: { $in: ["pending", "paid"] },
  });

  if (!existingTransaction) {
    throw new Error("Verified subscription transaction was not found.");
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

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  if (
    subscription.metadata?.vendorId !== vendorId ||
    subscription.metadata?.plan !== "premium"
  ) {
    throw new Error("Stripe subscription metadata does not match the vendor.");
  }

  if (!["active", "trialing"].includes(subscription.status)) {
    return;
  }

  const currentPeriodEnd =
    subscription.items.data[0]?.current_period_end;

  if (!currentPeriodEnd) {
    throw new Error("Stripe subscription period end is unavailable.");
  }

  const transactionResult = await transactions.updateOne(
    {
      stripeSessionId: session.id,
      vendorId: vendorObjectId,
      status: { $in: ["pending", "paid"] },
    },
    {
      $set: {
        status: "paid",
        stripeSubscriptionId: subscriptionId,
      },
    }
  );

  if (transactionResult.matchedCount !== 1) {
    throw new Error("Subscription transaction could not be verified.");
  }

  // Do not let an older checkout overwrite a different current subscription.
  // A missing or expired previous subscription can be replaced.
  await getUsersCollection().updateOne(
    {
      _id: vendorObjectId,
      role: "vendor",
      isBlocked: false,
      $or: [
        { stripeSubscriptionId: { $exists: false } },
        { stripeSubscriptionId: subscriptionId },
        {
          subscriptionExpiresAt: {
            $lte: new Date(),
          },
        },
        {
          subscriptionExpiresAt: {
            $type: "null",
          },
        },
        {
          subscriptionExpiresAt: {
            $exists: false,
          },
        },
      ],
    },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt: new Date(currentPeriodEnd * 1000),
        stripeSubscriptionId: subscriptionId,
      },
    }
  );

  // A blocked or missing vendor is not activated.
  // The verified payment transaction is still retained.
};

const handleSubscriptionLifecycle = async (
  event: StripeEvent
): Promise<void> => {
  const eventSubscription =
    event.data.object as StripeSubscription;

  const vendorId = eventSubscription.metadata?.vendorId;

  if (
    !vendorId ||
    eventSubscription.metadata?.plan !== "premium"
  ) {
    throw new Error("Vendor ID or plan is missing from subscription metadata.");
  }

  const vendorObjectId = parseVendorId(vendorId);
  const subscriptionId = eventSubscription.id;

  const transactions = getTransactionsCollection();

  // A lifecycle event must belong to a verified, paid transaction.
  // If checkout.session.completed has not arrived yet, throw so Stripe retries.
  const transaction = await transactions.findOne({
    vendorId: vendorObjectId,
    plan: "premium",
    stripeSubscriptionId: subscriptionId,
    status: "paid",
  });

  if (!transaction) {
    throw new Error(
      "A paid transaction for this Stripe subscription was not found."
    );
  }

  let latestSubscription: StripeSubscription;

  try {
    latestSubscription = await getStripeClient().subscriptions.retrieve(
      subscriptionId
    );
  } catch (error) {
    // Stripe may no longer return a deleted subscription.
    // In that case, the signed deletion event is the source of truth.
    if (event.type !== "customer.subscription.deleted") {
      throw error;
    }

    latestSubscription = eventSubscription;
  }

  if (
    latestSubscription.metadata?.vendorId !== vendorId ||
    latestSubscription.metadata?.plan !== "premium"
  ) {
    throw new Error("Retrieved Stripe subscription metadata does not match.");
  }

  const isActive =
    event.type !== "customer.subscription.deleted" &&
    ["active", "trialing"].includes(latestSubscription.status);

  if (isActive) {
    const currentPeriodEnd =
      latestSubscription.items.data[0]?.current_period_end;

    if (!currentPeriodEnd) {
      throw new Error("Stripe subscription period end is unavailable.");
    }

    await getUsersCollection().updateOne(
      {
        _id: vendorObjectId,
        role: "vendor",
        isBlocked: false,
        stripeSubscriptionId: subscriptionId,
      },
      {
        $set: {
          subscriptionPlan: "premium",
          subscriptionExpiresAt: new Date(currentPeriodEnd * 1000),
        },
      }
    );

    return;
  }

  if (event.type === "customer.subscription.deleted") {
    await getUsersCollection().updateOne(
      {
        _id: vendorObjectId,
        role: "vendor",
        stripeSubscriptionId: subscriptionId,
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

    return;
  }

  // For non-active states such as past_due, downgrade the vendor.
  // Keep the subscription ID so a later recovery to active can reactivate it.
  await getUsersCollection().updateOne(
    {
      _id: vendorObjectId,
      role: "vendor",
      stripeSubscriptionId: subscriptionId,
    },
    {
      $set: {
        subscriptionPlan: "free",
        subscriptionExpiresAt: null,
      },
    }
  );
};

export const handleSubscriptionWebhook = async (
  event: StripeEvent
): Promise<void> => {
  if (event.type === "checkout.session.completed") {
    await handleCheckoutCompleted(event);
    return;
  }

  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await handleSubscriptionLifecycle(event);
  }
};
