import { z } from "zod";

export const menuCategories = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
] as const;

export const createMenuItemSchema = z.object({
  itemName: z
    .string()
    .trim()
    .min(3, "Item name must be at least 3 characters.")
    .max(100, "Item name cannot exceed 100 characters."),

  category: z.enum(menuCategories),

  description: z
    .string()
    .trim()
    .min(10, "Description must be at least 10 characters.")
    .max(1000, "Description cannot exceed 1000 characters."),

  price: z
    .number()
    .finite()
    .positive("Price must be greater than 0."),

  location: z
    .string()
    .trim()
    .min(2, "Location is required.")
    .max(150, "Location cannot exceed 150 characters."),

  images: z
    .array(z.string().url("Each image must be a valid URL."))
    .min(1, "At least one menu image is required."),
});

export const updateAvailabilitySchema = z.object({
  isActive: z.boolean(),
}).strict();

export const updateMenuItemSchema = z.union([
  updateAvailabilitySchema,
  createMenuItemSchema
    .partial()
    .strict()
    .refine(
      (data) => Object.keys(data).length > 0,
      "At least one field is required to update.",
    ),
]);

export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;

export const createMenuItemFieldsSchema = createMenuItemSchema.omit({
  images: true,
});

export const updateMenuItemStatusSchema = z.object({
  status: z.enum([
    "pending",
    "approved",
    "rejected",
    "inactive",
  ]),
});

export type UpdateMenuItemStatusInput = z.infer<typeof updateMenuItemStatusSchema>; 

// Admin menu listing query validation.
export const adminMenuQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),

  status: z.enum([
    "pending",
    "approved",
    "rejected",
    "inactive",
  ]).optional(),

  category: z.enum(menuCategories).optional(),

  location: z.string().trim().max(150).optional(),

  sort: z.enum([
    "newest",
    "oldest",
    "price-asc",
    "price-desc",
  ]).default("newest"),

  page: z.coerce.number().int().min(1).default(1),

  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type AdminMenuQuery = z.infer<typeof adminMenuQuerySchema>;
