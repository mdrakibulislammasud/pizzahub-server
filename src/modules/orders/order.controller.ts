import type { Request, Response } from "express";

import {
  createOrderSchema,
  updateOrderStatusSchema,
} from "./order.validation.js";

import {
  OrderServiceError,
  createOrder,
  getCustomerOrders,
  getVendorOrders,
  getAdminOrders,
  updateVendorOrderStatus,
  cancelCustomerOrder,
} from "./order.service.js";

const handleOrderError = (
  res: Response,
  error: unknown,
  fallbackMessage: string,
): void => {
  if (error instanceof OrderServiceError) {
    res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
    return;
  }

  console.error("Order API error:", error);

  res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
};

// CUSTOMER: CREATE ORDER
export const createOrderController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = createOrderSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Invalid order information.",
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  if (!req.user?.id) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  try {
    const order = await createOrder(req.user.id, parsed.data);

    res.status(201).json({
      success: true,
      message: "Order placed successfully.",
      data: order,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to create order.");
  }
};

// CUSTOMER: GET OWN ORDERS
export const getCustomerOrdersController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (!req.user?.id) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  try {
    const orders = await getCustomerOrders(req.user.id);

    res.status(200).json({
      success: true,
      message: "Customer orders retrieved successfully.",
      data: orders,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to retrieve customer orders.");
  }
};

// VENDOR: GET OWN CUSTOMER ORDERS
export const getVendorOrdersController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (!req.user?.id) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  try {
    const orders = await getVendorOrders(req.user.id);

    res.status(200).json({
      success: true,
      message: "Vendor orders retrieved successfully.",
      data: orders,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to retrieve vendor orders.");
  }
};

// VENDOR: ACCEPT OR REJECT ORDER
export const updateVendorOrderStatusController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = updateOrderStatusSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: "Invalid order status.",
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  if (!req.user?.id) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  try {
    const order = await updateVendorOrderStatus(
      String(req.params.id),
      req.user.id,
      parsed.data.status,
    );

    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Order ${parsed.data.status} successfully.`,
      data: order,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to update order status.");
  }
};

// CUSTOMER: CANCEL OWN PENDING ORDER
export const cancelCustomerOrderController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (!req.user?.id) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
    return;
  }

  try {
    const order = await cancelCustomerOrder(String(req.params.id), req.user.id);

    if (!order) {
      res.status(404).json({
        success: false,
        message: "Order not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Order cancelled successfully.",
      data: order,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to cancel order.");
  }
};




// ADMIN: GET ALL ORDERS
export const getAdminOrdersController = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const orders = await getAdminOrders();

    res.status(200).json({
      success: true,
      message: "All orders retrieved successfully.",
      data: orders,
    });
  } catch (error) {
    handleOrderError(res, error, "Failed to retrieve all orders.");
  }
};