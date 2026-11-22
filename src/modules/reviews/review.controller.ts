import type { Request, Response } from "express";
import { ObjectId, UUID } from "mongodb";
import type { Collection } from "mongodb";
import { client } from "../../config/db.js";
import { env } from "../../config/env.js";

interface Review {
  reviewerId: string;
  reviewerName: string;
  reviewerImage?: string;
  rating: number;
  comment: string;
  createdAt: Date;
}

interface ReviewDocument {
  reviews?: Review[];
  restaurantReviews?: Review[];
  status?: string;
  isActive?: boolean;
  vendorId?: string;
}

interface UserDocument {
  _id: UUID;
  name?: string;
  image?: string;
  role?: string;
  isBlocked?: boolean;
  restaurantReviews?: Review[];
}

const menuCollection = () =>
  client.db(env.DB_NAME).collection<ReviewDocument>("menuItems");

const usersCollection = () =>
  client.db(env.DB_NAME).collection<UserDocument>("user");

const getReviewStats = (reviews: Review[] = []) => ({
  averageRating: reviews.length
    ? Number(
        (reviews.reduce((sum, review) => sum + review.rating, 0) /
          reviews.length).toFixed(1)
      )
    : 0,
  totalReviews: reviews.length,
});

const validateReview = (body: Request["body"]) => {
  const rating = Number(body?.rating);
  const comment =
    typeof body?.comment === "string" ? body.comment.trim() : "";

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { valid: false as const, message: "Rating must be between 1 and 5." };
  }

  if (comment.length < 3 || comment.length > 500) {
    return {
      valid: false as const,
      message: "Review must be between 3 and 500 characters.",
    };
  }

  return { valid: true as const, rating, comment };
};

const createReviewEntry = (
  reviewer: UserDocument,
  reviewerId: string,
  rating: number,
  comment: string
): Review => ({
  reviewerId,
  reviewerName: reviewer.name || "Customer",
  ...(reviewer.image ? { reviewerImage: reviewer.image } : {}),
  rating,
  comment,
  createdAt: new Date(),
});

const replaceUserReview = async (
  collection: Collection<any>,
  filter: Record<string, unknown>,
  field: "reviews" | "restaurantReviews",
  review: Review
) => {
  await collection.updateOne(filter, [
    {
      $set: {
        [field]: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: [`$${field}`, []] },
                as: "entry",
                cond: {
                  $ne: ["$$entry.reviewerId", review.reviewerId],
                },
              },
            },
            [{ $literal: review }],
          ],
        },
      },
    },
  ]);
};

export const getMenuReviewsController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string;

    if (!ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid menu item ID." });
      return;
    }

    const item = await menuCollection().findOne(
      { _id: new ObjectId(id), status: "approved" },
      { projection: { reviews: 1 } }
    );

    if (!item) {
      res.status(404).json({ success: false, message: "Menu item not found." });
      return;
    }

    const reviews = item.reviews || [];

    res.status(200).json({
      success: true,
      data: { reviews, ...getReviewStats(reviews) },
    });
  } catch (error) {
    console.error("Get menu reviews error:", error);
    res.status(500).json({ success: false, message: "Failed to load reviews." });
  }
};

export const createMenuReviewController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const reviewerId = req.user?.id;

    if (!reviewerId) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const validation = validateReview(req.body);

    if (!validation.valid) {
      res.status(400).json({ success: false, message: validation.message });
      return;
    }

    const id = req.params.id as string;

    if (!ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid menu item ID." });
      return;
    }

    const item = await menuCollection().findOne({
      _id: new ObjectId(id),
      status: "approved",
      isActive: { $ne: false },
    });

    if (!item) {
      res.status(404).json({ success: false, message: "Menu item not found or unavailable." });
      return;
    }

    if (item.vendorId === reviewerId) {
      res.status(403).json({ success: false, message: "You cannot review your own menu item." });
      return;
    }

    const reviewer = await usersCollection().findOne({
      _id: new UUID(reviewerId),
      role: "customer",
      isBlocked: { $ne: true },
    });

    if (!reviewer) {
      res.status(403).json({ success: false, message: "Only active customers can submit reviews." });
      return;
    }

    const review = createReviewEntry(
      reviewer,
      reviewerId,
      validation.rating,
      validation.comment
    );

    await replaceUserReview(
      menuCollection(),
      { _id: new ObjectId(id), status: "approved" },
      "reviews",
      review
    );

    const updated = await menuCollection().findOne(
      { _id: new ObjectId(id) },
      { projection: { reviews: 1 } }
    );

    const reviews = updated?.reviews || [];

    res.status(200).json({
      success: true,
      message: "Your review has been saved.",
      data: { reviews, ...getReviewStats(reviews) },
    });
  } catch (error) {
    console.error("Create menu review error:", error);
    res.status(500).json({ success: false, message: "Failed to save review." });
  }
};

export const getRestaurantReviewsController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const vendorId = req.params.vendorId as string;

    let vendorUUID: UUID;
    try {
      vendorUUID = new UUID(vendorId);
    } catch {
      res.status(400).json({ success: false, message: "Invalid restaurant ID." });
      return;
    }

    const vendor = await usersCollection().findOne(
      { _id: vendorUUID, role: "vendor", isBlocked: { $ne: true } },
      { projection: { restaurantReviews: 1, businessName: 1, name: 1 } }
    );

    if (!vendor) {
      res.status(404).json({ success: false, message: "Restaurant not found." });
      return;
    }

    const reviews = vendor.restaurantReviews || [];

    res.status(200).json({
      success: true,
      data: { reviews, ...getReviewStats(reviews) },
    });
  } catch (error) {
    console.error("Get restaurant reviews error:", error);
    res.status(500).json({ success: false, message: "Failed to load restaurant reviews." });
  }
};

export const createRestaurantReviewController = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const reviewerId = req.user?.id;

    if (!reviewerId) {
      res.status(401).json({ success: false, message: "Authentication required." });
      return;
    }

    const validation = validateReview(req.body);

    if (!validation.valid) {
      res.status(400).json({ success: false, message: validation.message });
      return;
    }

    const vendorId = req.params.vendorId as string;

    let vendorUUID: UUID;
    try {
      vendorUUID = new UUID(vendorId);
    } catch {
      res.status(400).json({ success: false, message: "Invalid restaurant ID." });
      return;
    }

    if (vendorId === reviewerId) {
      res.status(403).json({ success: false, message: "You cannot review your own restaurant." });
      return;
    }

    const reviewer = await usersCollection().findOne({
      _id: new UUID(reviewerId),
      role: "customer",
      isBlocked: { $ne: true },
    });

    if (!reviewer) {
      res.status(403).json({ success: false, message: "Only active customers can submit reviews." });
      return;
    }

    const vendor = await usersCollection().findOne({
      _id: vendorUUID,
      role: "vendor",
      isBlocked: { $ne: true },
    });

    if (!vendor) {
      res.status(404).json({ success: false, message: "Restaurant not found." });
      return;
    }

    const review = createReviewEntry(
      reviewer,
      reviewerId,
      validation.rating,
      validation.comment
    );

    await replaceUserReview(
      usersCollection(),
      { _id: vendorUUID, role: "vendor" },
      "restaurantReviews",
      review
    );

    const updated = await usersCollection().findOne(
      { _id: vendorUUID },
      { projection: { restaurantReviews: 1 } }
    );

    const reviews = updated?.restaurantReviews || [];

    res.status(200).json({
      success: true,
      message: "Your restaurant review has been saved.",
      data: { reviews, ...getReviewStats(reviews) },
    });
  } catch (error) {
    console.error("Create restaurant review error:", error);
    res.status(500).json({ success: false, message: "Failed to save restaurant review." });
  }
};



