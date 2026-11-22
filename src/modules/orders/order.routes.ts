import { getVendorAnalyticsController } from "./vendor-analytics.controller.js";
import { Router } from "express";

import { verifyToken } from "../../middleware/verifyToken.js";
import { authorizeRoles } from "../../middleware/authorizeRoles.js";
import { getCustomerDashboardOverviewController } from "./customer-dashboard.controller.js";

import {
  createOrderController,
  getCustomerOrdersController,
  getVendorOrdersController,
  updateVendorOrderStatusController,
  cancelCustomerOrderController,
} from "./order.controller.js";

const router = Router();

// ==========================================
// CUSTOMER ROUTES
// ==========================================

// Create a new order
router.post(
  "/",
  verifyToken,
  authorizeRoles("customer"),
  createOrderController,
);

// Get customer dashboard overview
router.get(
  "/customer/overview",
  verifyToken,
  authorizeRoles("customer"),
  getCustomerDashboardOverviewController,
);

// Get customer's own orders
router.get(
  "/my-orders",
  verifyToken,
  authorizeRoles("customer"),
  getCustomerOrdersController,
);

// Cancel own pending order
router.patch(
  "/:id/cancel",
  verifyToken,
  authorizeRoles("customer"),
  cancelCustomerOrderController,
);

// ==========================================
// VENDOR ROUTES
// ==========================================

// Get orders received by the vendor
router.get(
  "/vendor/my-orders",
  verifyToken,
  authorizeRoles("vendor"),
  getVendorOrdersController,
);

// Accept or reject a pending order
router.patch(
  "/vendor/:id/status",
  verifyToken,
  authorizeRoles("vendor"),
  updateVendorOrderStatusController,
);

router.get(
  "/vendor/analytics",
  verifyToken,
  authorizeRoles("vendor"),
  getVendorAnalyticsController,
);

export default router;
