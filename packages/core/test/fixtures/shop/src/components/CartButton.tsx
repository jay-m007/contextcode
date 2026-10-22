import { addToCart, type CartItem } from "@/lib/cart";

export const CartButton = ({ items, sku }: { items: CartItem[]; sku: string }) => (
  <button onClick={() => addToCart(items, sku)}>Add to cart</button>
);
