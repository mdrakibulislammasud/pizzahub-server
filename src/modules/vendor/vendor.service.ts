import { UUID } from "mongodb";

import { client } from "../../config/db.js";
import { env } from "../../config/env.js";

import type { VendorDashboardOverview } from "./vendor.interface.js";

// --------------------------------------------------
// DATABASE DOCUMENT TYPES
// --------------------------------------------------

interface VendorDocument {
  _id: UUID;
  role?: string;
  isBlocked?: boolean;
  subscriptionPlan?: string;
  subscriptionExpiresAt?: Date | null;
}

// --------------------------------------------------
// CUSTOM ERROR
// --------------------------------------------------

export class VendorDashboardServiceError extends Error {
  constructor(
    message: string,
    public statusCode: 404,
  ) {
    super(message);
    this.name = "VendorDashboardServiceError";
  }
}

// --------------------------------------------------
// COLLECTION HELPERS
// --------------------------------------------------

const usersCollection = () =>
  client.db(env.DB_NAME).collection<VendorDocument>("user");

const menuCollection = () =>
  client.db(env.DB_NAME).collection("menuItems");

const orderCollection = () =>
  client.db(env.DB_NAME).collection("orders");

// --------------------------------------------------
// VENDOR DASHBOARD OVERVIEW
// --------------------------------------------------

export const getVendorDashboardOverview = async (
  vendorId: string,
): Promise<VendorDashboardOverview> => {
  const vendor = await usersCollection().findOne({
    _id: new UUID(vendorId),
  });

  if (!vendor || vendor.role !== "vendor") {
    throw new VendorDashboardServiceError(
      "Vendor account not found.",
      404,
    );
  }

  if (vendor.isBlocked) {
    throw new VendorDashboardServiceError(
      "Blocked vendors cannot access the dashboard.",
      404,
    );
  }

  const [totalMenuItems, activeMenuItems, pendingOrders, acceptedOrders] =
    await Promise.all([
      menuCollection().countDocuments({ vendorId }),

      menuCollection().countDocuments({
        vendorId,
        status: "approved",
        isActive: { $ne: false },
      }),

      orderCollection().countDocuments({
        vendorId,
        status: "pending",
      }),

      orderCollection().countDocuments({
        vendorId,
        status: "accepted",
      }),
    ]);

  const hasActivePremium =
    vendor.subscriptionPlan === "premium" &&
    vendor.subscriptionExpiresAt instanceof Date &&
    vendor.subscriptionExpiresAt.getTime() > Date.now();

  return {
    totalMenuItems,
    activeMenuItems,
    pendingOrders,
    acceptedOrders,
    subscriptionPlan: hasActivePremium ? "premium" : "free",
    subscriptionExpiresAt: hasActivePremium
      ? vendor.subscriptionExpiresAt!
      : null,
  };
};
