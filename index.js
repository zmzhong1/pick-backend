// index.js — Scan & Pick backend (Direct Shopify, ESM)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();

// --- CORS (dev-friendly). If you prefer strict, set ALLOWED_ORIGIN in .env ---
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true, credentials: true }));
app.use(express.json());

// --- ENV / Shopify endpoints ---
const SHOP = process.env.SHOPIFY_SHOP; // e.g. ssxqid-8t.myshopify.com
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // shpat_***
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';
const GRAPHQL_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// --- Helpers ---
function toGid(type, idOrGid) {
  const s = String(idOrGid);
  if (s.startsWith('gid://')) return s;
  return `gid://shopify/${type}/${s}`;
}

async function shopifyGraphQL(query, variables = {}) {
  try {
    const res = await axios.post(
      GRAPHQL_URL,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': TOKEN,
        },
        timeout: 15000,
      }
    );
    if (res.data.errors) {
      console.error('Shopify top-level errors:', JSON.stringify(res.data.errors, null, 2));
      throw new Error('GraphQL errors');
    }
    return res.data.data;
  } catch (err) {
    if (err.response) {
      console.error('HTTP', err.response.status, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('ERR', err.message);
    }
    throw err;
  }
}

// Build Shopify draft search query
function buildDraftQuery({ since, until }) {
  // Dates should be YYYY-MM-DD (Shopify accepts ISO8601; this is sufficient for daily ranges)
  const parts = [];
  if (since) parts.push(`created_at:>=${since}`);
  if (until) parts.push(`created_at:<=${until}`);
  // Only open drafts are pickable; adjust if you tag drafts instead
  parts.push('status:open');
  return parts.join(' ');
}

// --- GraphQL Docs ---
const LIST_DRAFTS = `#graphql
  query ListDrafts($first: Int!, $query: String) {
    draftOrders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
          updatedAt
          email
          shippingAddress { city province country zip }
          lineItems(first: 1) { edges { node { quantity } } }
        }
      }
    }
  }
`;



const DRAFT_FOR_PICK = `#graphql
  query DraftForPick($id: ID!) {
    draftOrder(id: $id) {
      id
      lineItems(first: 250) {
        edges {
          node {
            id
            quantity
            variant {
              id
              sku
              barcode
              title
              image { originalSrc }
              product { title }
            }
          }
        }
      }
      shippingAddress { address1 city province country zip }
    }
  }
`;

const COMPLETE_DRAFT = `#graphql
  mutation CompleteDraft($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      order { id name }
      userErrors { field message }
    }
  }
`;

// --- Routes ---
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>Scan & Pick Backend</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li>GET /api/pick/drafts?since=YYYY-MM-DD&until=YYYY-MM-DD&first=50</li>
      <li>GET /api/pick/jobs/{draftId or gid}</li>
      <li>POST /api/pick/complete { draftId, paymentPending }</li>
    </ul>
  `);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// List drafts by date window
app.get('/api/pick/drafts', async (req, res) => {
  try {
    const { since, until, first } = req.query;
    const query = buildDraftQuery({ since, until });
    const data = await shopifyGraphQL(LIST_DRAFTS, {
      first: Math.min(Number(first) || 25, 250),
      query,
    });

    const items = (data?.draftOrders?.edges || []).map(({ node }) => ({
      id: node.id,
      createdAt: node.createdAt,
      email: node.email,
      shipping: node.shippingAddress,
      totalLinesHint: node.lineItems?.edges?.reduce((n, e) => n + (e?.node?.quantity || 0), 0) || 0,
    }));

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'failed to list drafts' });
  }
});

// Fetch single draft as pick job
app.get('/api/pick/jobs/:draftId', async (req, res) => {
  try {
    const draftId = toGid('DraftOrder', req.params.draftId);
    const data = await shopifyGraphQL(DRAFT_FOR_PICK, { id: draftId });
    const d = data?.draftOrder;
    if (!d) return res.status(404).json({ error: 'Draft not found' });

    const lines = (d.lineItems?.edges || []).map(({ node }) => ({
      lineItemId: node.id,
      variantId: node.variant?.id ?? null,
      title: node.variant?.product?.title ?? 'Unknown',
      sku: node.variant?.sku ?? null,
      barcode: node.variant?.barcode ?? null,
      qty: node.quantity,
      thumb: node.variant?.image?.originalSrc ?? null,
    }));

    res.json({
      draftId: d.id,
      shippingAddress: d.shippingAddress,
      lines,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch draft' });
  }
});

// Complete draft (creates an Order)
app.post('/api/pick/complete', async (req, res) => {
  try {
    const { draftId, paymentPending = true } = req.body;
    if (!draftId) return res.status(400).json({ error: 'draftId required' });

    const id = toGid('DraftOrder', draftId);
    const data = await shopifyGraphQL(COMPLETE_DRAFT, { id, paymentPending });
    const out = data?.draftOrderComplete;

    if (out?.userErrors?.length) {
      return res.status(400).json({ errors: out.userErrors });
    }
    res.json({ order: out?.order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete draft' });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Pick backend listening on :${PORT}`));
