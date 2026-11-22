import type { Request, Response } from "express";
import { UUID, type ObjectId } from "mongodb";

import { client } from "../../config/db.js";
import { env } from "../../config/env.js";
import { getAdminDashboardStats } from "./admin-dashboard.service.js";

interface UserDocument {
  _id: UUID;
  name?: string;
  businessName?: string;
  role?: string;
  createdAt?: Date;
}

interface OrderDocument {
  _id: ObjectId;
  customerId: string;
  vendorId: string;
  itemId: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: Date;
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

const dateKey = (date: Date): string =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const getUUID = (value: string): UUID | null => {
  try {
    return new UUID(value);
  } catch {
    return null;
  }
};

export const getAdminAnalyticsController = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const days = Number(req.query.days ?? 30);

  const vendorId =
    typeof req.query.vendorId === "string"
      ? req.query.vendorId.trim()
      : "";

  if (![7, 30, 90].includes(days)) {
    res.status(400).json({
      success: false,
      message: "days must be 7, 30 or 90.",
    });
    return;
  }

  const vendorUUID = vendorId ? getUUID(vendorId) : null;

  if (vendorId && !vendorUUID) {
    res.status(400).json({
      success: false,
      message: "Invalid vendor ID.",
    });
    return;
  }

  try {
    const db = client.db(env.DB_NAME);

    const users = db.collection<UserDocument>("user");
    const orders = db.collection<OrderDocument>("orders");
    const transactions =
      db.collection<TransactionDocument>("transactions");
    const menu = db.collection("menuItems");

    const since = new Date(
      Date.now() - days * 86_400_000
    );

    const orderMatch: Record<string, unknown> = {
      createdAt: { $gte: since },
    };

    const paymentMatch: Record<string, unknown> = {
      createdAt: { $gte: since },
      status: "paid",
    };

    if (vendorUUID) {
      orderMatch.vendorId = vendorUUID.toString();
      paymentMatch.vendorId = vendorUUID;
    }

    const [
      overview,
      newCustomers,
      approvedMenuItems,
      vendors,
      trendGroups,
      paymentGroups,
      recent,
    ] = await Promise.all([
      getAdminDashboardStats(),

      users.countDocuments({
        role: "customer",
        createdAt: { $gte: since },
      }),

      menu.countDocuments({ status: "approved" }),

      users
        .find(
          { role: "vendor" },
          {
            projection: {
              name: 1,
              businessName: 1,
            },
          },
        )
        .sort({ name: 1 })
        .limit(300)
        .toArray(),

      orders.aggregate<{
        _id: { day: string; status: string };
        count: number;
      }>([
        { $match: orderMatch },
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
          },
        },
      ]).toArray(),

      transactions.aggregate<{
        _id: { day: string; currency: string };
        amountMinor: number;
        count: number;
      }>([
        { $match: paymentMatch },
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
              currency: { $toLower: "$currency" },
            },
            amountMinor: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]).toArray(),

      orders
        .find(orderMatch)
        .sort({ createdAt: -1 })
        .limit(40)
        .toArray(),
    ]);

    const dayKeys = Array.from(
      { length: days },
      (_, i) =>
        dateKey(
          new Date(
            Date.now() -
              (days - 1 - i) * 86_400_000,
          ),
        ),
    );

    const trends = dayKeys.map((day) => ({
      day,
      orders: 0,
      accepted: 0,
      rejected: 0,
      pending: 0,
      cancelled: 0,
    }));

    const trendByDay = new Map(
      trends.map((value) => [value.day, value]),
    );

    const statuses = {
      pending: 0,
      accepted: 0,
      rejected: 0,
      cancelled: 0,
    };

    for (const group of trendGroups) {
      const row = trendByDay.get(group._id.day);

      const status =
        group._id.status as keyof typeof statuses;

      if (!row || !(status in statuses)) {
        continue;
      }

      row.orders += group.count;
      row[status] += group.count;
      statuses[status] += group.count;
    }

    const revenueMap = new Map<
      string,
      {
        currency: string;
        amountMinor: number;
        count: number;
        trend: {
          day: string;
          value: number;
        }[];
      }
    >();

    for (const group of paymentGroups) {
      const currency =
        group._id.currency || "usd";

      let entry = revenueMap.get(currency);

      if (!entry) {
        entry = {
          currency,
          amountMinor: 0,
          count: 0,
          trend: dayKeys.map((day) => ({
            day,
            value: 0,
          })),
        };

        revenueMap.set(currency, entry);
      }

      entry.amountMinor += group.amountMinor;
      entry.count += group.count;

      const day = entry.trend.find(
        (t) => t.day === group._id.day,
      );

      if (day) {
        day.value += group.amountMinor;
      }
    }

    const ids = [
      ...new Set(
        recent.flatMap((order) => [
          order.customerId,
          order.vendorId,
        ]),
      ),
    ]
      .map(getUUID)
      .filter((id): id is UUID => id !== null);

    const people = ids.length
      ? await users
          .find(
            { _id: { $in: ids } },
            {
              projection: {
                name: 1,
                businessName: 1,
              },
            },
          )
          .toArray()
      : [];

    const peopleMap = new Map(
      people.map((person) => [
        person._id.toString(),
        person,
      ]),
    );

    const orderCount = Object.values(statuses)
      .reduce((sum, count) => sum + count, 0);

    const percentage = (count: number) =>
      orderCount
        ? Math.round((count / orderCount) * 100)
        : 0;

    res.status(200).json({
      success: true,
      data: {
        days,

        overview: {
          ...overview,
          approvedMenuItems,
          newCustomers,
        },

        statuses,
        orderCount,

        rates: {
          accepted: percentage(statuses.accepted),
          rejected: percentage(statuses.rejected),
          pending: percentage(statuses.pending),
        },

        trends,

        revenues: [...revenueMap.values()].sort(
          (a, b) => b.amountMinor - a.amountMinor,
        ),

        vendors: vendors.map((v) => ({
          id: v._id.toString(),
          name:
            v.businessName ||
            v.name ||
            "Restaurant",
        })),

        recentOrders: recent.map((order) => ({
          id: order._id.toString(),

          restaurant:
            peopleMap.get(order.vendorId)?.businessName ||
            peopleMap.get(order.vendorId)?.name ||
            "Restaurant",

          customer:
            peopleMap.get(order.customerId)?.name ||
            "Customer",

          itemName:
            order.itemSnapshot?.itemName ||
            "Pizza item",

          itemPrice:
            order.itemSnapshot?.price ?? null,

          status: order.status,
          createdAt: order.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    console.error("Admin analytics error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load admin analytics.",
    });
  }
};
