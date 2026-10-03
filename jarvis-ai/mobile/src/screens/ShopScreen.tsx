import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView } from 'react-native';
import { Glass, Input, Screen, T } from '../components/ui';
import { useAssistant } from '../hooks/AssistantContext';
import { listProducts } from '../services/ai/api';
import { SHOP_NAME } from '../config';
import { friendly } from '../utils';
import type { Product } from '../types';

export default function ShopScreen({ navigation }: any) {
  const { colors } = useAssistant();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [items, setItems] = useState<Product[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { const r = await listProducts(q, cat); setItems(r.products); setCats(r.categories); } catch (e) { setErr(friendly(e)); setItems([]); }
    setLoading(false);
  }, [q, cat]);
  useEffect(() => { void load(); }, [cat]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen title={`🏪 ${SHOP_NAME}`} onBack={() => navigation.goBack()}>
      <T sub size={12}>Live catalogue from the shop backend. Stock shown is exactly what the shop admin entered — if it says unknown, call the shop.</T>
      <Input value={q} onChangeText={setQ} placeholder="Search products" returnKeyType="search" onSubmitEditing={load} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        {['', ...cats].map((c) => (
          <Pressable key={c || 'all'} onPress={() => setCat(c)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginRight: 8, backgroundColor: cat === c ? colors.accent : colors.panel }}>
            <T style={{ color: cat === c ? '#04121c' : colors.text }}>{c || 'All'}</T>
          </Pressable>
        ))}
      </ScrollView>
      {loading && <T sub>Loading…</T>}
      {!!err && <T style={{ color: colors.err }}>{err}</T>}
      {!loading && !err && items.length === 0 && <T sub>No products found.</T>}
      {items.map((p) => (
        <Glass key={p.id}>
          <T bold>{p.name}</T>
          <T sub size={12}>{p.category} · {p.unit}</T>
          {!!p.description && <T size={14}>{p.description}</T>}
          <T style={{ color: p.inStock ? colors.ok : colors.err }}>{p.inStock ? 'In stock' : 'Out of stock'}{p.stockQty != null ? ` (${p.stockQty})` : ''}{p.price != null ? ` · ₹${p.price}` : ''}</T>
          <T sub size={11}>Updated {new Date(p.updatedAt).toLocaleDateString()}</T>
        </Glass>
      ))}
    </Screen>
  );
}
