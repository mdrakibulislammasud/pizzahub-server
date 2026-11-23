import { Router } from "express";

import { verifyToken } from "../middleware/verifyToken.js";
import { authorizeRoles } from "../middleware/authorizeRoles.js";
import { uploadMenuImages } from "../middleware/upload.middleware.js";
import {
  getMenuReviewsController,
  createMenuReviewController,
  getRestaurantReviewsController,
  createRestaurantReviewController,
} from "../modules/reviews/review.controller.js";

import {
  createMenuItemController,
  getPublicMenuItemsController,
  getPublicMenuItemByIdController,
  getVendorMenuItemsController,
  updateVendorMenuItemController,
  deleteVendorMenuItemController,
  getAllMenuItemsForAdminController,
  updateMenuItemStatusController,
  deleteMenuItemByAdminController,
} from "../modules/menu/menu.controller.js";


const router = Router();

// ==========================================
// ADMIN PROTECTED ROUTES
// ==========================================

router.get(
  "/admin/all",
  verifyToken,
  authorizeRoles("admin"),
  getAllMenuItemsForAdminController,
);

router.patch(
  "/admin/:id/status",
  verifyToken,
  authorizeRoles("admin"),
  updateMenuItemStatusController,
);

router.delete(
  "/admin/:id",
  verifyToken,
  authorizeRoles("admin"),
  deleteMenuItemByAdminController,
);

// ==========================================
// REVIEWS
// ==========================================

// Keep the restaurant route before /:id so route intent stays explicit.
router.get("/restaurant/:vendorId/reviews", getRestaurantReviewsController);
router.post(
  "/restaurant/:vendorId/reviews",
  verifyToken,
  authorizeRoles("customer"),
  createRestaurantReviewController,
);
router.get("/:id/reviews", getMenuReviewsController);
router.post(
  "/:id/reviews",
  verifyToken,
  authorizeRoles("customer"),
  createMenuReviewController,
);

// ==========================================
// PUBLIC ROUTES
// ==========================================

router.get("/", getPublicMenuItemsController);
router.get("/:id", getPublicMenuItemByIdController);

// ==========================================
// VENDOR PROTECTED ROUTES
// ==========================================

router.post(
  "/",
  verifyToken,
  authorizeRoles("vendor"),
  uploadMenuImages,
  createMenuItemController,
);

router.get(
  "/vendor/my-items",
  verifyToken,
  authorizeRoles("vendor"),
  getVendorMenuItemsController,
);

router.patch(
  "/:id",
  verifyToken,
  authorizeRoles("vendor"),
  updateVendorMenuItemController,
);

router.delete(
  "/:id",
  verifyToken,
  authorizeRoles("vendor"),
  deleteVendorMenuItemController,
);
export default router;
