
import { z } from "zod";

const objectIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{24}$/,
    "Please provide a valid menu item ID.",
  );

const deliveryDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Delivery date must use YYYY-MM-DD format.",
  )
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);

    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Please provide a valid delivery date.")
  .refine((value) => {
    const today = new Date();

    const todayInBangladesh = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(today);

    return value > todayInBangladesh;
  }, "Delivery date must be a future date. Same-day delivery is not available.");

export const createOrderSchema = z.object({
  itemId: objectIdSchema,

  // Quantity: minimum 1, maximum 99
  quantity: z
    .number()
    .int("Quantity must be a whole number.")
    .min(1, "Minimum quantity is 1.")
    .max(99, "Maximum quantity is 99.")
    .default(1),

  deliveryDate: deliveryDateSchema,

  deliveryAddress: z
    .string()
    .trim()
    .min(5, "Delivery address must be at least 5 characters.")
    .max(300, "Delivery address cannot exceed 300 characters."),

  message: z
    .string()
    .trim()
    .max(500, "Message cannot exceed 500 characters.")
    .optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export type UpdateOrderStatusInput = z.infer<
  typeof updateOrderStatusSchema
>;
