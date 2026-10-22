export interface CartItem {
  sku: string;
  quantity: number;
}

export function addToCart(items: CartItem[], sku: string): CartItem[] {
  const existing = items.find((i) => i.sku === sku);
  if (existing) return items.map((i) => (i.sku === sku ? { ...i, quantity: i.quantity + 1 } : i));
  return [...items, { sku, quantity: 1 }];
}

export function cartTotal(items: CartItem[], prices: Record<string, number>): number {
  return items.reduce((sum, i) => sum + (prices[i.sku] ?? 0) * i.quantity, 0);
}
