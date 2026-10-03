import { Router } from 'express';
import { db } from '../database/db.js';
import { searchProducts } from '../tools/index.js';

export const shopRouter = Router();

shopRouter.get('/shop/products', (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 100);
  const category = String(req.query.category ?? '').slice(0, 60);
  const categories = (db.prepare('SELECT name FROM categories ORDER BY name').all() as { name: string }[]).map((c) => c.name);
  res.json({ products: searchProducts(q, category), categories });
});
