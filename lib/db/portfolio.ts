import { and, desc, eq } from "drizzle-orm";
import type { Side } from "../trading/types";
import { db } from "./client";
import { accounts, orderStatusEnum, orders, positions } from "./schema";

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];

export type PortfolioPosition = {
  symbol: string;
  quantity: number;
  avgCostCents: bigint;
};

export type PortfolioOrder = {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  status: OrderStatus;
  filledPriceCents: bigint | null;
  createdAt: Date;
  filledAt: Date | null;
};

export type Portfolio = {
  cashCents: bigint;
  positions: PortfolioPosition[];
  recentOrders: PortfolioOrder[];
};

// A single query, not three sequential ones: positions and the 20 most
// recent orders are independent one-to-many children of the same account,
// so LEFT JOINing both onto it in one SELECT is one database round trip
// under pgbouncer's transaction-mode pooling (see lib/db/client.ts) instead
// of three separate pool checkouts. Joining two independent 1:N relations
// this way fans out into their cross product per account (P positions x O
// orders rows) - harmless at this scale (a portfolio holds a handful of
// positions, orders is capped at 20) - so the rows are deduplicated back
// into distinct positions and orders below rather than trusted as-is.
export async function getPortfolio(accountId: string): Promise<Portfolio> {
  const recentOrders = db
    .select()
    .from(orders)
    .where(eq(orders.accountId, accountId))
    .orderBy(desc(orders.createdAt))
    .limit(20)
    .as("recent_orders");

  const rows = await db
    .select({
      cashCents: accounts.cashCents,
      positionSymbol: positions.symbol,
      positionQuantity: positions.quantity,
      positionAvgCostCents: positions.avgCostCents,
      orderId: recentOrders.id,
      orderSymbol: recentOrders.symbol,
      orderSide: recentOrders.side,
      orderQuantity: recentOrders.quantity,
      orderStatus: recentOrders.status,
      orderFilledPriceCents: recentOrders.filledPriceCents,
      orderCreatedAt: recentOrders.createdAt,
      orderFilledAt: recentOrders.filledAt,
    })
    .from(accounts)
    .leftJoin(positions, eq(positions.accountId, accounts.id))
    .leftJoin(recentOrders, eq(recentOrders.accountId, accounts.id))
    .where(eq(accounts.id, accountId));

  const firstRow = rows[0];

  if (!firstRow) {
    throw new Error(`Account ${accountId} not found`);
  }

  const positionsBySymbol = new Map<string, PortfolioPosition>();
  const ordersById = new Map<string, PortfolioOrder>();

  for (const row of rows) {
    if (
      row.positionSymbol !== null &&
      row.positionQuantity !== null &&
      row.positionAvgCostCents !== null
    ) {
      positionsBySymbol.set(row.positionSymbol, {
        symbol: row.positionSymbol,
        quantity: row.positionQuantity,
        avgCostCents: row.positionAvgCostCents,
      });
    }

    if (
      row.orderId !== null &&
      row.orderSymbol !== null &&
      row.orderSide !== null &&
      row.orderQuantity !== null &&
      row.orderStatus !== null &&
      row.orderCreatedAt !== null
    ) {
      ordersById.set(row.orderId, {
        id: row.orderId,
        symbol: row.orderSymbol,
        side: row.orderSide,
        quantity: row.orderQuantity,
        status: row.orderStatus,
        filledPriceCents: row.orderFilledPriceCents,
        createdAt: row.orderCreatedAt,
        filledAt: row.orderFilledAt,
      });
    }
  }

  return {
    cashCents: firstRow.cashCents,
    positions: [...positionsBySymbol.values()],
    recentOrders: [...ordersById.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    ),
  };
}

export type HeldPosition = {
  quantity: number;
  avgCostCents: bigint;
};

// A single-symbol lookup, not a filter over getPortfolio's full result - the
// stock detail page only ever needs one position, and getPortfolio's join
// against every position and the 20 most recent orders would be wasted work
// for that.
export async function getPosition(accountId: string, symbol: string): Promise<HeldPosition | null> {
  const [row] = await db
    .select({ quantity: positions.quantity, avgCostCents: positions.avgCostCents })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.symbol, symbol)));

  return row ?? null;
}
