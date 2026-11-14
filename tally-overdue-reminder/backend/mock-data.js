// Sample data used when config.json has "useMockData": true.
// Lets you build and demo the dashboard without a live Tally connection.
// Shape matches what tally-client.js normalizes real Tally XML responses
// into: one balance per customer (no per-bill due dates - Tally doesn't
// track those here), plus recent Sales invoices used to find the last
// purchase date and recent product rates.

const mockCustomers = [
  { customerName: "Shree Traders", balance: 63500, lastSaleDate: "2026-07-22", owes: true, mobile: "+91 98220 11111" },
  { customerName: "Patil Hardware", balance: 92300, lastSaleDate: "2026-05-15", owes: true, mobile: null },
  { customerName: "Deshmukh Agro Center", balance: 12750, lastSaleDate: "2026-08-05", owes: true, mobile: "09765022222" },
];

const mockInvoices = {
  "Shree Traders": [
    {
      voucherNumber: "1078",
      date: "2026-07-22",
      items: [
        { productName: "PVC Pipe 2\"", qty: 88, unit: "PCS", rate: 210, gstPercent: 18, rateInclGst: 247.8, amount: 18480 },
      ],
    },
    {
      voucherNumber: "1042",
      date: "2026-06-10",
      items: [
        { productName: "Cement Bag 50kg", qty: 80, unit: "BAG", rate: 385, gstPercent: 28, rateInclGst: 492.8, amount: 30800 },
        { productName: "PVC Pipe 2\"", qty: 68, unit: "PCS", rate: 210, gstPercent: 18, rateInclGst: 247.8, amount: 14280 },
      ],
    },
  ],
  "Patil Hardware": [
    {
      voucherNumber: "990",
      date: "2026-05-15",
      items: [
        { productName: "GI Wire 12mm", qty: 972, unit: "MTR", rate: 95, gstPercent: 18, rateInclGst: 112.1, amount: 92340 },
      ],
    },
  ],
  "Deshmukh Agro Center": [
    {
      voucherNumber: "1103",
      date: "2026-08-05",
      items: [
        { productName: "Sprayer Pump 16L", qty: 8, unit: "PCS", rate: 1450, gstPercent: 18, rateInclGst: 1711, amount: 11600 },
        { productName: "Urea 45kg Bag", qty: 4, unit: "BAG", rate: 266, gstPercent: 5, rateInclGst: 279.3, amount: 1064 },
      ],
    },
  ],
};

function getMockCustomers() {
  return mockCustomers;
}

function getMockProductRates(customerName) {
  const invoices = mockInvoices[customerName] || [];
  const rates = new Map();
  for (const inv of invoices) {
    for (const item of inv.items) {
      const existing = rates.get(item.productName);
      if (!existing || inv.date > existing.voucherDate) {
        rates.set(item.productName, { ...item, voucherDate: inv.date });
      }
    }
  }
  return Array.from(rates.values()).map(({ productName, rate, gstPercent, rateInclGst, voucherDate }) => ({
    productName,
    rate,
    gstPercent,
    rateInclGst,
    voucherDate,
  }));
}

function getMockInvoices(customerName) {
  return mockInvoices[customerName] || [];
}

function getMockAllProductRates() {
  const rates = new Map();
  for (const [customerName, invoices] of Object.entries(mockInvoices)) {
    for (const inv of invoices) {
      for (const item of inv.items) {
        const existing = rates.get(item.productName);
        if (!existing || inv.date > existing.voucherDate) {
          rates.set(item.productName, { ...item, voucherDate: inv.date, lastCustomer: customerName });
        }
      }
    }
  }
  return Array.from(rates.values())
    .map(({ productName, rate, gstPercent, rateInclGst, voucherDate, lastCustomer }) => ({
      productName,
      rate,
      gstPercent,
      rateInclGst,
      voucherDate,
      lastCustomer,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// Rates you paid your suppliers, keyed by product - the "khareedi rate" side
// of the Item Rate lookup. Sample purchase costs, roughly below the sale
// rates above so the margin looks realistic.
const mockPurchases = [
  { supplier: "Agro Distributors Pvt Ltd", date: "2026-07-10", items: [
    { productName: "PVC Pipe 2\"", rate: 175, gstPercent: 18, rateInclGst: 206.5, amount: 0 },
  ]},
  { supplier: "Bharat Cement Suppliers", date: "2026-06-01", items: [
    { productName: "Cement Bag 50kg", rate: 330, gstPercent: 28, rateInclGst: 422.4, amount: 0 },
  ]},
  { supplier: "Metro Wire Traders", date: "2026-05-02", items: [
    { productName: "GI Wire 12mm", rate: 80, gstPercent: 18, rateInclGst: 94.4, amount: 0 },
  ]},
  { supplier: "Krushi Seva Kendra", date: "2026-07-28", items: [
    { productName: "Sprayer Pump 16L", rate: 1200, gstPercent: 18, rateInclGst: 1416, amount: 0 },
    { productName: "Urea 45kg Bag", rate: 245, gstPercent: 5, rateInclGst: 257.25, amount: 0 },
  ]},
];

function getMockAllProductPurchaseRates() {
  const rates = new Map();
  for (const purchase of mockPurchases) {
    for (const item of purchase.items) {
      const existing = rates.get(item.productName);
      if (!existing || purchase.date > existing.voucherDate) {
        rates.set(item.productName, { ...item, voucherDate: purchase.date, supplier: purchase.supplier });
      }
    }
  }
  return Array.from(rates.values())
    .map(({ productName, rate, gstPercent, rateInclGst, voucherDate, supplier }) => ({
      productName,
      rate,
      gstPercent,
      rateInclGst,
      voucherDate,
      supplier,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

module.exports = {
  getMockCustomers,
  getMockProductRates,
  getMockInvoices,
  getMockAllProductRates,
  getMockAllProductPurchaseRates,
};
