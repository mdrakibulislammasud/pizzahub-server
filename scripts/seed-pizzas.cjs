
const { MongoClient } = require("mongodb");
process.loadEnvFile(".env");
const fs = require("node:fs");
const path = require("node:path");

const uri = process.env.MONGODB_URI;

const dbName = process.env.DB_NAME || "pizzahub";

const originalVendorId =
  "5fb602ac-e960-4410-9a48-64c21c802db4";

const imageFolder = path.resolve(
  __dirname,
  "../../pizzahub-client/public/images"
);

// SAFETY CHECK

if (!process.argv.includes("--dev-seed")) {
  throw new Error("Development seed flag required.");
}

if (!uri) {
  throw new Error("MONGODB_URI is missing.");
}

if (dbName !== "pizzahub") {
  throw new Error("Unexpected database name.");
}

// PIZZA CATALOG

const pizzas = [
  {
    itemName: "Margherita Pizza",
    category: "Classic Pizzas",
    price: 450,
    description: "Mozzarella, tomato sauce and fresh basil.",
    image: "margherita-pizza.jpg",
  },
  {
    itemName: "Pepperoni Pizza",
    category: "Meat Lovers",
    price: 650,
    description: "Pepperoni, mozzarella and tomato sauce.",
    image: "menu/pepperoni.jpg",
  },
  {
    itemName: "BBQ Chicken Pizza",
    category: "Meat Lovers",
    price: 690,
    description: "Grilled chicken with BBQ sauce and cheese.",
    image: "menu/bbq-chicken.jpg",
  },
  {
    itemName: "Four Cheese Pizza",
    category: "Specialty / Gourmet Pizzas",
    price: 750,
    description: "A combination of four delicious cheeses.",
    image: "menu/four-cheese.jpg",
  },
  {
    itemName: "Meat Lovers Pizza",
    category: "Meat Lovers",
    price: 850,
    description: "Loaded with assorted meat toppings.",
    image: "menu/meat-lovers.jpg",
  },
  {
    itemName: "Veggie Delight Pizza",
    category: "Vegetarian Pizzas",
    price: 490,
    description: "Fresh vegetables, olives and mozzarella.",
    image: "menu/veggie-delight.jpg",
  },
  {
    itemName: "Spicy Chicken Pizza",
    category: "Meat Lovers",
    price: 620,
    description: "Spicy chicken, peppers and cheese.",
    image: "menu/spicy-chicken.jpg",
  },
  {
    itemName: "Mushroom Cheese Pizza",
    category: "Vegetarian Pizzas",
    price: 580,
    description: "Mushrooms and creamy mozzarella.",
    image: "menu/mushroom-cheese.jpg",
  },
  {
    itemName: "Mexican Hot Pizza",
    category: "Specialty / Gourmet Pizzas",
    price: 720,
    description: "Mexican-inspired spicy pizza.",
    image: "menu/mexican-hot.jpg",
  },
  {
    itemName: "Italian Supreme Pizza",
    category: "Specialty / Gourmet Pizzas",
    price: 890,
    description: "Italian pizza with assorted toppings.",
    image: "menu/italian-supreme.jpg",
  },
  {
    itemName: "Chicken Alfredo Pizza",
    category: "Specialty / Gourmet Pizzas",
    price: 790,
    description: "Chicken with creamy Alfredo sauce.",
    image: "menu/chicken-alfredo.jpg",
  },
];

// CHECK VENDOR SUBSCRIPTION

function isPremium(vendor) {
  return (
    vendor.subscriptionPlan === "premium" &&
    vendor.subscriptionExpiresAt &&
    new Date(vendor.subscriptionExpiresAt) > new Date()
  );
}

// FIND VALID TEST VENDORS

async function findTestVendor(db) {
  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();

  const names = collections.map(
    (collection) => collection.name
  );

  console.log("Database:", db.databaseName);
  console.log("Collections:", names.join(", "));

  const vendors = [];

  for (const name of ["user", "users"]) {
    if (!names.includes(name)) {
      continue;
    }

    const records = await db
      .collection(name)
      .find(
        { role: "vendor" },
        {
          projection: {
            _id: 1,
            id: 1,
            name: 1,
            email: 1,
            role: 1,
            isBlocked: 1,
            subscriptionPlan: 1,
            subscriptionExpiresAt: 1,
          },
        }
      )
      .toArray();

    console.log(
      `${name} collection vendors:`,
      records.length
    );

    vendors.push(...records);
  }

  const testVendors = vendors.filter((vendor) => {
    const email = String(vendor.email || "");
    const name = String(vendor.name || "");

    return (
      !vendor.isBlocked &&
      email.endsWith("@example.com") &&
      (
        email.startsWith("vendor-") ||
        /test vendor/i.test(name)
      )
    );
  });

  console.log(
    "Available test vendors:",
    testVendors.length
  );

  if (testVendors.length === 0) {
    throw new Error(
      "No valid test vendor exists in this database."
    );
  }

  // Prefer an active premium test vendor

  const premiumVendors = testVendors.filter(isPremium);

  const matchesOriginal = (vendor) =>
    String(vendor.id || "") === originalVendorId ||
    String(vendor._id || "") === originalVendorId;

  const vendor =
    premiumVendors.find(matchesOriginal) ||
    premiumVendors[0] ||
    testVendors.find(matchesOriginal) ||
    testVendors[0];

  console.log("Selected vendor:", vendor.name);

  console.log(
    "Vendor plan:",
    isPremium(vendor) ? "Premium" : "Free"
  );

  return vendor;
}

// UPLOAD IMAGE TO IMGBB

async function uploadImage(filePath) {
  if (!process.env.IMGBB_API_KEY) {
    throw new Error("IMGBB_API_KEY is missing.");
  }

  const form = new FormData();

  form.append("key", process.env.IMGBB_API_KEY);

  form.append(
    "image",
    fs.readFileSync(filePath).toString("base64")
  );

  const response = await fetch(
    "https://api.imgbb.com/1/upload",
    {
      method: "POST",
      body: form,
    }
  );

  const result = await response.json();

  if (
    !response.ok ||
    !result.success ||
    !result.data?.url
  ) {
    throw new Error("ImgBB upload failed.");
  }

  return result.data.url;
}

// MAIN SEED FUNCTION

async function seedPizzas() {
  const client = new MongoClient(uri);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  try {
    await client.connect();

    console.log("MongoDB connected successfully.");

    const db = client.db(dbName);

    const menu = db.collection("menuItems");

    const vendor = await findTestVendor(db);

    const vendorId = String(vendor.id || vendor._id);

    console.log("Selected vendor ID:", vendorId);

    // FOLLOW SUBSCRIPTION LIMIT

    const limit = isPremium(vendor) ? Infinity : 3;

    let activeCount = await menu.countDocuments({
      vendorId,
      status: {
        $in: ["approved", "pending"],
      },
    });

    console.log("Existing vendor items:", activeCount);

    // ADD PIZZAS

    for (const pizza of pizzas) {
      const existing = await menu.findOne({
        itemName: pizza.itemName,
        vendorId,
      });

      if (existing) {
        console.log("Already exists:", pizza.itemName);
        skipped++;
        continue;
      }

      if (activeCount >= limit) {
        console.log("Vendor limit reached:", pizza.itemName);
        skipped++;
        continue;
      }

      const imagePath = path.join(
        imageFolder,
        pizza.image
      );

      if (!fs.existsSync(imagePath)) {
        console.log("Missing image:", pizza.image);
        skipped++;
        continue;
      }

      try {
        const imageUrl = await uploadImage(imagePath);

        const now = new Date();

        await menu.insertOne({
          itemName: pizza.itemName,
          category: pizza.category,
          description: pizza.description,
          price: pizza.price,
          location: "Uttara, Dhaka",
          images: [imageUrl],
          vendorId,
          status: "approved",
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });

        console.log("Added:", pizza.itemName);

        added++;
        activeCount++;
      } catch (error) {
        console.error(
          "Failed:",
          pizza.itemName,
          error.message
        );

        failed++;
      }
    }

    const total = await menu.countDocuments({
      status: "approved",
    });

    console.log("\n============================");
    console.log("PIZZAHUB SEED RESULT");
    console.log("============================");

    console.log("Added:", added);
    console.log("Skipped:", skipped);
    console.log("Failed:", failed);
    console.log("Total approved pizzas:", total);

  } finally {
    await client.close();
  }
}

seedPizzas().catch((error) => {
  console.error("Seed error:", error.message);
  process.exitCode = 1;
});
