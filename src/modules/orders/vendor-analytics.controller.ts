import type { Request, Response } from "express";
import { UUID, type ObjectId } from "mongodb";

import { client } from "../../config/db.js";
import { env } from "../../config/env.js";

type OrderStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled";

interface VendorDocument {
  _id: UUID;
  name?: string;
  businessName?: string;
  subscriptionPlan?: "free" | "premium";
  subscriptionExpiresAt?: Date | null;
}

interface CustomerDocument {
  _id: UUID;
  name?: string;
}

interface OrderDocument {
  _id: ObjectId;
  vendorId: string;
  customerId: string;
  itemId: string;
  quantity?: number;
  totalPrice?: number;
  status: OrderStatus;
  createdAt: Date;
  deliveryDate?: string;

  itemSnapshot?: {
    itemName?: string;
    price?: number;
  };
}

interface TransactionDocument {
  vendorId: UUID;
  status: string;
  amount: number;
  currency: string;
  createdAt: Date;
}

const bangladeshDay = (date: Date): string =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export const getVendorAnalyticsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  if (
    !req.user ||
    req.user.role !== "vendor"
  ) {
    res.status(403).json({
      success: false,
      message: "Vendor access required.",
    });
    return;
  }

  const days = Number(req.query.days ?? 30);

  if (![7, 30, 90].includes(days)) {
    res.status(400).json({
      success: false,
      message: "Select 7, 30 or 90 days.",
    });
    return;
  }

  try {
    // Always use the verified JWT identity.
    // Never accept vendorId from the browser.
    const vendorId = req.user.id;
    const vendorUUID = new UUID(vendorId);

    const db = client.db(env.DB_NAME);

    const users =
      db.collection<VendorDocument>("user");

    const orders =
      db.collection<OrderDocument>("orders");

    const menu =
      db.collection("menuItems");

    const transactions =
      db.collection<TransactionDocument>(
        "transactions",
      );

    const dayKeys = Array.from(
      { length: days },
      (_, index) =>
        bangladeshDay(
          new Date(
            Date.now() -
              (days - 1 - index) * 86400000,
          ),
        ),
    );

    const since = new Date(
      `${dayKeys[0]}T00:00:00+06:00`,
    );

    const orderFilter = {
      vendorId,
      createdAt: { $gte: since },
    };

    const [
      vendor,
      totalMenuItems,
      activeMenuItems,
      pendingMenuItems,
      pendingOrders,
      customerIds,
      statusGroups,
      recentOrders,
      topItems,
      payments,
    ] = await Promise.all([
      users.findOne({
        _id: vendorUUID,
      }),

      menu.countDocuments({
        vendorId,
      }),

      menu.countDocuments({
        vendorId,
        status: "approved",
        isAvailable: { $ne: false },
        isActive: { $ne: false },
      }),

      menu.countDocuments({
        vendorId,
        status: "pending",
      }),

      orders.countDocuments({
        vendorId,
        status: "pending",
      }),

      orders.distinct(
        "customerId",
        orderFilter,
      ),

      orders.aggregate<{
        _id: {
          day: string;
          status: string;
        };
        count: number;
        acceptedValue: number;
      }>([
        {
          $match: orderFilter,
        },

        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "Asia/Dhaka",
                },
              },
              status: "$status",
            },

            count: { $sum: 1 },

            acceptedValue: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$status",
                      "accepted",
                    ],
                  },
                  {
                    $ifNull: [
                      "$totalPrice",
                      {
                        $multiply: [
                          { $ifNull: ["$itemSnapshot.price", 0] },
                          { $ifNull: ["$quantity", 1] },
                        ],
                      },
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]).toArray(),

      orders
        .find(orderFilter)
        .sort({
          createdAt: -1,
        })
        .limit(50)
        .toArray(),

      orders.aggregate<{
        _id: string;
        name?: string;
        count: number;
      }>([
        {
          $match: orderFilter,
        },

        {
          $group: {
            _id: "$itemId",
            name: {
              $first: "$itemSnapshot.itemName",
            },
            count: { $sum: 1 },
          },
        },

        {
          $sort: {
            count: -1,
          },
        },

        {
          $limit: 5,
        },
      ]).toArray(),

      transactions.aggregate<{
        _id: string;
        amountMinor: number;
        count: number;
      }>([
        {
          $match: {
            vendorId: vendorUUID,
            status: "paid",
            createdAt: { $gte: since },
          },
        },

        {
          $group: {
            _id: {
              $toLower: "$currency",
            },
            amountMinor: {
              $sum: "$amount",
            },
            count: {
              $sum: 1,
            },
          },
        },
      ]).toArray(),
    ]);

    if (!vendor) {
      res.status(404).json({
        success: false,
        message: "Vendor not found.",
      });
      return;
    }

    const trends = dayKeys.map((day) => ({
      day,
      total: 0,
      pending: 0,
      accepted: 0,
      rejected: 0,
      cancelled: 0,
      acceptedValue: 0,
    }));

    const trendsMap = new Map(
      trends.map((row) => [
        row.day,
        row,
      ]),
    );

    const statuses: Record<OrderStatus, number> = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      cancelled: 0,
    };

    let acceptedOrderValue = 0;

    for (const group of statusGroups) {
      const status =
        group._id.status as OrderStatus;

      if (!(status in statuses)) {
        continue;
      }

      statuses[status] += group.count;

      acceptedOrderValue +=
        group.acceptedValue;

      const row =
        trendsMap.get(group._id.day);

      if (row) {
        row.total += group.count;
        row[status] += group.count;
        row.acceptedValue +=
          group.acceptedValue;
      }
    }

    const totalOrders =
      Object.values(statuses).reduce(
        (sum, value) => sum + value,
        0,
      );

    const percentage = (count: number) =>
      totalOrders
        ? Math.round(
            (count / totalOrders) * 100,
          )
        : 0;

    const customerUUIDs: UUID[] = [];

    for (const order of recentOrders) {
      try {
        customerUUIDs.push(
          new UUID(order.customerId),
        );
      } catch {
        // Ignore invalid historical user IDs.
      }
    }

    const customers: CustomerDocument[] =
      customerUUIDs.length > 0
        ? await db
            .collection<CustomerDocument>(
              "user",
            )
            .find({
              _id: {
                $in: customerUUIDs,
              },
            })
            .toArray()
        : [];

    const customerMap = new Map(
      customers.map((customer) => [
        customer._id.toString(),
        customer.name || "Customer",
      ]),
    );

    const expiresAt =
      vendor.subscriptionExpiresAt ?? null;

    const premiumActive =
      vendor.subscriptionPlan ===
        "premium" &&
      expiresAt instanceof Date &&
      expiresAt.getTime() > Date.now();

    res.status(200).json({
      success: true,

      data: {
        days,

        vendor: {
          name:
            vendor.businessName ||
            vendor.name ||
            "Restaurant",

          subscriptionPlan:
            premiumActive
              ? "premium"
              : "free",

          subscriptionExpiresAt:
            expiresAt,
        },

        overview: {
          totalMenuItems,
          activeMenuItems,
          pendingMenuItems,
          pendingOrders,

          uniqueCustomers:
            customerIds.length,

          acceptedOrders:
            statuses.accepted,

          acceptedOrderValue,
        },

        statuses,
        totalOrders,

        rates: {
          accepted: percentage(
            statuses.accepted,
          ),

          rejected: percentage(
            statuses.rejected,
          ),

          pending: percentage(
            statuses.pending,
          ),
        },

        trends,

        topItems: topItems.map(
          (item) => ({
            id: item._id,
            name:
              item.name || "Menu item",
            count: item.count,
          }),
        ),

        subscriptionSpend:
          payments.map((payment) => ({
            currency: payment._id,
            amountMinor:
              payment.amountMinor,
            count: payment.count,
          })),

        recentOrders:
          recentOrders.map((order) => ({
            id: order._id.toString(),

            customer:
              customerMap.get(
                order.customerId,
              ) || "Customer",

            itemName:
              order.itemSnapshot
                ?.itemName ||
              "Menu item",

            itemPrice:
              order.itemSnapshot
                ?.price ?? null,

            status: order.status,

            deliveryDate:
              order.deliveryDate ?? "",

            createdAt:
              order.createdAt,
          })),
      },
    });
  } catch (error) {
    console.error(
      "Vendor analytics error:",
      error,
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to load vendor analytics.",
    });
  }
};
