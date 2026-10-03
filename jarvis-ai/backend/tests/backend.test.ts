import { describe, expect, it, beforeAll } from 'vitest';

process.env.JWT_SECRET = 'x'.repeat(40);
process.env.APP_ACCESS_CODE = 'test-access-code';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_USERNAME = 'admin';
process.env.AI_API_KEY = ''; // AI intentionally unconfigured

const { calculate } = await import('../src/tools/calc.js');
const { buildApp } = await import('../src/app.js');
const { seedAdmin } = await import('../src/database/db.js');
const bcrypt = (await import('bcryptjs')).default;

describe('calculate', () => {
  it('handles percentages', () => {
    expect(calculate('25000*18/100')).toBe(4500);
    expect(calculate('18% of 25000')).toBe(4500);
    expect(calculate('(2+3)*4^2')).toBe(80);
    expect(calculate('-5 + 10%')).toBeCloseTo(-4.9);
  });
  it('rejects code and division by zero', () => {
    expect(() => calculate('process.exit()')).toThrow();
    expect(() => calculate('1/0')).toThrow();
    expect(() => calculate('1+')).toThrow();
  });
});

describe('API security', () => {
  let server: import('node:http').Server; let base = '';
  beforeAll(async () => {
    const { config } = await import('../src/config.js');
    (config as any).adminPasswordHash = bcrypt.hashSync('adminpass', 4);
    seedAdmin();
    await new Promise<void>((r) => { server = buildApp().listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    return () => server.close();
  });
  const post = (p: string, body: unknown, token?: string) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });

  it('rejects unauthenticated and wrong access code', async () => {
    expect((await fetch(base + '/api/health')).status).toBe(401);
    expect((await post('/api/auth/device', { accessCode: 'nope', deviceId: 'device-12345' })).status).toBe(401);
  });

  it('issues a token, then reports AI not configured instead of faking an answer', async () => {
    const r = await post('/api/auth/device', { accessCode: 'test-access-code', deviceId: 'device-12345' });
    expect(r.status).toBe(200);
    const { token } = await r.json() as { token: string };
    expect((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(200);
    const c = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, token);
    expect(c.status).toBe(503);
    // user token must not open the admin API
    expect((await fetch(base + '/admin/api/stats', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401);
  });

  it('admin flow: login, add product, user sees it, disable user', async () => {
    const bad = await post('/admin/api/login', { username: 'admin', password: 'wrong' });
    expect(bad.status).toBe(401);
    const { token: admin } = await (await post('/admin/api/login', { username: 'admin', password: 'adminpass' })).json() as { token: string };
    const add = await post('/admin/api/products', { name: 'Test Fungicide', category: 'Fungicide', unit: '100 g', inStock: true, stockQty: null, price: null }, admin);
    expect(add.status).toBe(200);
    const { token } = await (await post('/api/auth/device', { accessCode: 'test-access-code', deviceId: 'device-12345' })).json() as { token: string };
    const list = await (await fetch(base + '/api/shop/products?q=fungi', { headers: { Authorization: 'Bearer ' + token } })).json() as any;
    expect(list.products[0]).toMatchObject({ name: 'Test Fungicide', inStock: true, price: null, stockQty: null });
    const users = await (await fetch(base + '/admin/api/users', { headers: { Authorization: 'Bearer ' + admin } })).json() as any;
    await post(`/admin/api/users/${users.users[0].id}/disabled`, { disabled: true }, admin);
    expect((await fetch(base + '/api/health', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(403);
  });
});
