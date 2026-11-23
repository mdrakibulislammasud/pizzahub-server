import type { Request, Response } from "express";

import {
  createMenuItemFieldsSchema,
  updateMenuItemSchema,
  updateMenuItemStatusSchema,
  adminMenuQuerySchema,
  menuCategories,
} from "./menu.validation.js";

import {
  createMenuItem,
  getPublicMenuItems,
  getPublicMenuItemById,
  getVendorMenuItems,
  updateVendorMenuItem,
  setVendorMenuAvailability,
  deleteVendorMenuItem,
  getAllMenuItemsForAdmin,
  updateMenuItemStatus,
  deleteMenuItemByAdmin,
  MenuApprovalLimitError,
} from "./menu.service.js";

import { uploadImageToImgBB } from "../../utils/imgbb.js";

// ==========================================
// CREATE MENU ITEM (VENDOR)
// ==========================================

export const createMenuItemController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (req.user?.role !== "vendor") {
      res.status(403).json({
        success: false,
        message: "Only vendors can create menu items.",
      });
      return;
    }

    const uploadedFiles = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : [];

    if (uploadedFiles.length === 0) {
      res.status(400).json({
        success: false,
        message: "At least one menu item image is required.",
      });
      return;
    }

    const validation = createMenuItemFieldsSchema.safeParse({
      ...req.body,
      price: Number(req.body.price),
    });

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Invalid menu item information.",
        errors: validation.error.flatten().fieldErrors,
      });
      return;
    }

    const imageUrls = await Promise.all(
      uploadedFiles.map((file) => uploadImageToImgBB(file.buffer)),
    );

    const menuItem = await createMenuItem(req.user.id, {
      ...validation.data,
      images: imageUrls,
    });

    res.status(201).json({
      success: true,
      message: "Menu item submitted successfully. Awaiting admin approval.",
      data: menuItem,
    });
  } catch (error) {
    console.error("Create menu item error:", error);

    const message =
      error instanceof Error ? error.message : "Failed to create menu item.";

    const isBusinessError =
      message === "Vendor account not found." ||
      message === "Blocked vendors cannot create menu items." ||
      message.startsWith("Free plan allows");

    res.status(isBusinessError ? 400 : 500).json({
      success: false,
      message: isBusinessError
        ? message
        : "Something went wrong while creating the menu item.",
    });
  }
};

// ==========================================
// GET PUBLIC MENU ITEMS
// ==========================================

export const getPublicMenuItemsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;

    const category =
      typeof req.query.category === "string"
        ? req.query.category
        : undefined;

    const location =
      typeof req.query.location === "string"
        ? req.query.location
        : undefined;

    const sort =
      typeof req.query.sort === "string" ? req.query.sort : undefined;

    if (
      category &&
      !menuCategories.includes(category as (typeof menuCategories)[number])
    ) {
      res.status(400).json({
        success: false,
        message: "Invalid menu category.",
      });
      return;
    }

    if (sort && sort !== "price-asc" && sort !== "price-desc") {
      res.status(400).json({
        success: false,
        message: "Invalid sorting option.",
      });
      return;
    }

    const page =
      typeof req.query.page === "string" ? Number(req.query.page) : 1;

    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 12;

    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      res.status(400).json({
        success: false,
        message: "Page and limit must be positive integers.",
      });
      return;
    }

    const result = await getPublicMenuItems({
      search,
      category: category as (typeof menuCategories)[number] | undefined,
      location,
      sort: sort as "price-asc" | "price-desc" | undefined,
      page,
      limit,
    });

    res.status(200).json({
      success: true,
      message: "Menu items retrieved successfully.",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Get public menu items error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve menu items.",
    });
  }
};

// ==========================================
// GET SINGLE PUBLIC MENU ITEM
// ==========================================

export const getPublicMenuItemByIdController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const menuItem = await getPublicMenuItemById(req.params.id as string);

    if (!menuItem) {
      res.status(404).json({
        success: false,
        message: "Menu item not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Menu item retrieved successfully.",
      data: menuItem,
    });
  } catch (error) {
    console.error("Get menu item details error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve menu item details.",
    });
  }
};

// ==========================================
// GET VENDOR'S OWN MENU ITEMS
// ==========================================

export const getVendorMenuItemsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (req.user?.role !== "vendor") {
      res.status(403).json({
        success: false,
        message: "Only vendors can access their menu items.",
      });
      return;
    }

    const menuItems = await getVendorMenuItems(req.user.id);

    res.status(200).json({
      success: true,
      message: "Your menu items retrieved successfully.",
      data: menuItems,
    });
  } catch (error) {
    console.error("Get vendor menu items error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve your menu items.",
    });
  }
};

// ==========================================
// UPDATE VENDOR'S OWN MENU ITEM
// ==========================================

export const updateVendorMenuItemController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (req.user?.role !== "vendor") {
      res.status(403).json({
        success: false,
        message: "Only vendors can update menu items.",
      });
      return;
    }


    // VENDOR_AVAILABILITY_HANDLER
    // Visibility updates do not reset approval.

    if (
      req.body !== null &&
      typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      Object.keys(req.body).length === 1 &&
      typeof req.body.isActive === "boolean"
    ) {
      const updatedItem =
        await setVendorMenuAvailability(
          req.params.id as string,
          req.user.id,
          req.body.isActive,
        );

      if (!updatedItem) {
        res.status(404).json({
          success: false,
          message:
            "Approved menu item not found or access denied.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        message:
          "Menu availability updated successfully.",
        data: updatedItem,
      });

      return;
    }

    const validation = updateMenuItemSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Invalid menu item information.",
        errors: validation.error.flatten().fieldErrors,
      });
      return;
    }

    const updatedItem = await updateVendorMenuItem(
      req.params.id as string,
      req.user.id,
      validation.data,
    );

    if (!updatedItem) {
      res.status(404).json({
        success: false,
        message: "Menu item not found, not owned by you, or not eligible for this update.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Menu item updated successfully.",
      data: updatedItem,
    });
  } catch (error) {
    if (error instanceof MenuApprovalLimitError) {
      res.status(409).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("Update menu item error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update menu item.",
    });
  }
};

// ==========================================
// DELETE VENDOR'S OWN MENU ITEM
// ==========================================

export const deleteVendorMenuItemController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (req.user?.role !== "vendor") {
      res.status(403).json({
        success: false,
        message: "Only vendors can delete menu items.",
      });
      return;
    }

    const deleted = await deleteVendorMenuItem(
      req.params.id as string,
      req.user.id,
    );

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: "Menu item not found or you do not own this item.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Menu item deleted successfully.",
    });
  } catch (error) {
    console.error("Delete menu item error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete menu item.",
    });
  }
};


// ==========================================
// ADMIN MENU MANAGEMENT
// ==========================================

// GET ALL MENU ITEMS (ADMIN)
export const getAllMenuItemsForAdminController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
      const validation = adminMenuQuerySchema.safeParse(req.query);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Invalid menu query parameters.",
        errors: validation.error.issues,
      });
      return;
    }

    const result = await getAllMenuItemsForAdmin(validation.data);

    res.status(200).json({
      success: true,
      message: "All menu items retrieved successfully.",
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    console.error("Get all menu items error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to retrieve menu items.",
    });
  }
};

// UPDATE MENU ITEM STATUS (ADMIN)
export const updateMenuItemStatusController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const validation = updateMenuItemStatusSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        success: false,
        message: "Invalid menu item status.",
        errors: validation.error.issues,
      });
      return;
    }

    const updatedItem = await updateMenuItemStatus(
      req.params.id as string,
      validation.data.status,
    );

    if (!updatedItem) {
      res.status(404).json({
        success: false,
        message: "Menu item not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Menu item status updated successfully.",
      data: updatedItem,
    });
  } catch (error) {
    if (error instanceof MenuApprovalLimitError) {
      res.status(409).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("Update menu item status error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to update menu item status.",
    });
  }
};

// DELETE MENU ITEM (ADMIN)
export const deleteMenuItemByAdminController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const deleted = await deleteMenuItemByAdmin(
      req.params.id as string,
    );

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: "Menu item not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Menu item deleted successfully.",
    });
  } catch (error) {
    console.error("Admin delete menu item error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete menu item.",
    });
  }
};

