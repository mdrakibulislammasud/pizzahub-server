
export type OrderStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled";

export interface OrderMenuItemInfo {
  _id: string;
  itemName: string;
  images: string[];
  category: string;
  price: number;
  location: string;
}

export interface OrderVendorInfo {
  _id: string;
  name: string;
  email: string;
  image?: string | null;
  businessName?: string;
}

export interface OrderCustomerInfo {
  _id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface Order {
  _id?: string;

  itemId: string;
  vendorId: string;
  customerId: string;

  // NEW: Order quantity and calculated total
  quantity: number;
  totalPrice: number;

  deliveryDate: Date;
  deliveryAddress: string;
  message?: string;

  status: OrderStatus;
  createdAt: Date;

  itemSnapshot?: OrderMenuItemInfo;
}

export interface CustomerOrder extends Order {
  menuItem: OrderMenuItemInfo | null;
  menuItemSource: "snapshot" | "current-menu" | "unavailable";
  vendor: OrderVendorInfo | null;
}

export interface VendorOrder extends Order {
  menuItem: OrderMenuItemInfo | null;
  menuItemSource: "snapshot" | "current-menu" | "unavailable";
  customer: OrderCustomerInfo | null;
}
