# Commerce vs x402 — quick guide for merchants

EmDash can power **two different payment stories**. They solve different jobs. You can use **one, the other, or both** on the same site; they are not duplicates of each other.

---

## At a glance

|                                 | **EmDash Commerce** _(cart / checkout plugin)_                                                                                    | **x402** _(`@emdash-cms/x402`)_                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **What it’s for**               | Selling **products or services** with a **cart**, **checkout**, **orders**, and (when configured) **cards** via payment providers | **HTTP-native, pay-per-request** access — often for **content**, **APIs**, or **agent** traffic using **402 Payment Required** |
| **Typical buyer**               | Humans shopping on your storefront                                                                                                | Automated clients (AI agents, bots) or any client that speaks x402; can be combined with “humans free, bots pay”               |
| **Mental model**                | “I run a **shop**”                                                                                                                | “I charge **per access** to a URL or resource”                                                                                 |
| **Cart & line items**           | Yes — multiple items, quantities, variants                                                                                        | No — each paid request is its own transaction                                                                                  |
| **Order history & fulfillment** | Yes — orders, statuses, emails, operations _(as the plugin ships)_                                                                | No — it gates access; there is no built-in “order” object like a store                                                         |
| **Inventory & stock**           | Yes — core concern for physical / limited digital goods                                                                           | Not applicable — no SKU catalog                                                                                                |
| **Shipping & tax**              | Supported via **separate modules** when you need real quotes and addresses                                                        | Not applicable                                                                                                                 |
| **How payment feels**           | Familiar **checkout** (redirect, card form, wallet, depending on provider)                                                        | Client receives **402** + instructions, pays, **retries** the request with proof of payment                                    |
| **Best fit**                    | T-shirts, courses, licenses, donations with amounts, anything with a **catalog**                                                  | Articles, feeds, APIs, “charge scrapers/agents,” **micropayments** per view or call                                            |
| **Same site?**                  | Yes                                                                                                                               | Yes — e.g. **store** uses Commerce; **blog or API** uses x402                                                                  |

---

## Simple decision rule

- Choose **Commerce** when buyers pick **products**, you need **carts**, **orders**, or **inventory**.
- Choose **x402** when you want **automatic, request-level payment** (especially for **machines** or **per-access** pricing) without building a shop.

When in doubt: **shop-shaped problem → Commerce. Gate-shaped problem → x402.**

---

_This is a merchant summary. Technical architecture lives in `commerce-plugin-architecture.md` and the [x402 payments guide](docs/src/content/docs/guides/x402-payments.mdx)._
