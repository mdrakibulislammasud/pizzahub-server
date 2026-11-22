import { Router } from "express";

import { verifyToken } from "../middleware/verifyToken.js";
import { authorizeRoles } from "../middleware/authorizeRoles.js";
import { uploadMenuImage } from "../middleware/upload.middleware.js";

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
  uploadMenuImage,
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
