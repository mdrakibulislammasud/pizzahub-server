const { spawnSync } = require("node:child_process");
const { concurrently } = require("concurrently");
const Stripe = require("stripe");
const { MongoClient, UUID } = require("mongodb");

process.loadEnvFile(".env");

const key = process.env.STRIPE_SECRET_KEY;

const priceId = process.env.STRIPE_PRICE_ID;

const port = Number(process.env.PORT) || 5000;

const baseURL = `http://localhost:${port}`;

const webhookURL =
  `${baseURL}/api/subscriptions/webhook`;

const events = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed"
].join(",");

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function waitForBackend() {

  for (let i = 0; i < 60; i++) {

    try {

      const response = await fetch(baseURL, {
        signal: AbortSignal.timeout(2000)
      });

      if (response.ok) return;

    } catch {}

    await sleep(1000);
  }

  throw new Error("Backend did not become ready.");
}

async function recoverPreviousPayment(secret) {

  const stripe = new Stripe(key);

  const event = await stripe.events.retrieve(
    "evt_1Udy12ILL5j6UBL6TmSWLVY3"
  );

  if (
    event.livemode ||
    event.type !== "checkout.session.completed"
  ) {
    throw new Error("Invalid Sandbox event.");
  }

  const session =
    await stripe.checkout.sessions.retrieve(
      event.data.object.id
    );

  const vendorId = session.metadata?.vendorId;

  if (
    session.livemode ||
    session.status !== "complete" ||
    session.payment_status !== "paid" ||
    session.mode !== "subscription" ||
    session.metadata?.plan !== "premium" ||
    !vendorId ||
    session.client_reference_id !== vendorId
  ) {
    throw new Error("Checkout verification failed.");
  }

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!subscriptionId) {
    throw new Error("Subscription not found.");
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  if (
    subscription.livemode ||
    subscription.status !== "active" ||
    subscription.metadata?.vendorId !== vendorId ||
    subscription.metadata?.plan !== "premium" ||
    !subscription.items.data.some(
      item => item.price.id === priceId
    )
  ) {
    throw new Error("Subscription verification failed.");
  }

  const client = new MongoClient(
    process.env.MONGODB_URI
  );

  try {

    await client.connect();

    const db = client.db(
      process.env.DB_NAME || "pizzahub"
    );

    const vendorUUID = new UUID(vendorId);

    const vendor = await db.collection("user")
      .findOne({
        _id: vendorUUID,
        role: "vendor",
        isBlocked: false
      });

    if (!vendor) {
      throw new Error("Active vendor not found.");
    }

    const transaction = await db
      .collection("transactions")
      .findOne({
        vendorId: vendorUUID,
        stripeSessionId: session.id,
        plan: "premium",
        status: {
          $in: ["pending", "paid"]
        }
      });

    if (!transaction) {
      throw new Error("Matching transaction not found.");
    }

    if (
      vendor.subscriptionPlan === "premium" &&
      new Date(vendor.subscriptionExpiresAt).getTime()
        > Date.now() &&
      transaction.status === "paid"
    ) {

      console.log("Premium already active.");
      return;
    }

    console.log("Previous Stripe payment verified.");

    // One-time replay of a verified Sandbox event.
    // Never used for production payments.

    const payload = JSON.stringify(event);

    const signature =
      stripe.webhooks.generateTestHeaderString({
        payload,
        secret
      });

    const response = await fetch(webhookURL, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature
      },

      body: payload
    });

    console.log("Webhook HTTP:", response.status);

    if (!response.ok) {
      throw new Error("Webhook processing failed. Check backend logs.");
    }

    const updated = await db.collection("user")
      .findOne({
        _id: vendorUUID
      });

    const updatedTransaction = await db
      .collection("transactions")
      .findOne({
        stripeSessionId: session.id,
        vendorId: vendorUUID
      });

    if (
      updated?.subscriptionPlan === "premium" &&
      new Date(updated.subscriptionExpiresAt).getTime()
        > Date.now() &&
      updatedTransaction?.status === "paid"
    ) {

      console.log("============================");
      console.log("PREMIUM ACTIVATED SUCCESSFULLY");
      console.log("Vendor:", updated.name);
      console.log("Plan:", updated.subscriptionPlan);
      console.log("Expires:", updated.subscriptionExpiresAt);
      console.log("============================");

    } else {

      throw new Error("Premium activation not confirmed.");

    }

  } finally {

    await client.close();

  }
}

async function main() {

  if (!key?.startsWith("sk_test_")) {

    throw new Error(
      "This local launcher requires a Stripe Sandbox key."
    );

  }

  if (!priceId) {

    throw new Error("STRIPE_PRICE_ID is missing.");

  }

  // Keep CLI and backend in the same Stripe Sandbox.

  process.env.STRIPE_API_KEY = key;

  console.log("Configuring Stripe webhook...");


  const secretResult = spawnSync(
    "cmd.exe",
    ["/d", "/c", "stripe listen --print-secret"],
    {
      encoding: "utf8",
      env: process.env,
      timeout: 60000,
      windowsHide: true
    }
  );

  if (
    secretResult.error ||
    secretResult.status !== 0
  ) {
    const details = [
      secretResult.error?.message,
      secretResult.stdout,
      secretResult.stderr
    ]
      .filter(Boolean)
      .join("\n")
      .replace(
        /(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g,
        "[REDACTED]"
      );

    console.error("Stripe CLI error:", details);

    throw new Error(
      "Stripe CLI connection failed."
    );
  }

  const output =
    `${secretResult.stdout || ""}\n${secretResult.stderr || ""}`;

  const secret = output.match(
    /whsec_[A-Za-z0-9]+/
  )?.[0];

  if (!secret) {

    throw new Error(
      "Unable to obtain Stripe webhook signing secret."
    );

  }

  // Inject the correct secret into the backend process.
  // No manual .env editing is necessary.

  process.env.STRIPE_WEBHOOK_SECRET = secret;

  console.log("Stripe signing secret configured.");
  console.log("Starting Backend + Stripe Listener...");

  const { result } = concurrently(
    [
      {
        name: "BACKEND",
        command: "npm run dev",
        prefixColor: "green"
      },
      {
        name: "STRIPE",
        command:
          `stripe listen --events ${events} --forward-to ${webhookURL}`,
        prefixColor: "blue"
      }
    ],
    {
      killOthersOn: ["failure", "success"]
    }
  );

  if (process.argv.includes("--recover")) {

    (async () => {

      try {

        await waitForBackend();

        await recoverPreviousPayment(secret);

      } catch (error) {

        console.error("RECOVERY ERROR:", error.message);

      }

    })();

  }

  await result;
}

main().catch(error => {

  console.error("ERROR:", error.message);

  process.exitCode = 1;

});
