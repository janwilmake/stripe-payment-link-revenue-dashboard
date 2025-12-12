interface StripePaymentLink {
  id: string;
  active: boolean;
  url: string;
  line_items: {
    data: Array<{
      id: string;
      description: string;
      price: {
        id: string;
        product: {
          name: string;
        };
      };
      quantity: number;
      amount_total: number;
    }>;
  };
}

interface StripeCheckoutSession {
  id: string;
  payment_link: string;
  payment_status: string;
  payment_intent: {
    id: string;
    charges: {
      data: Array<{
        id: string;
        status: string;
        amount: number;
        currency: string;
        created: number;
        receipt_url: string;
        billing_details: {
          email: string;
        };
      }>;
    };
  };
}

interface PaymentLinkWithCharges {
  id: string;
  url: string;
  active: boolean;
  line_items: Array<{
    id: string;
    description: string;
    price_id: string;
    product_name: string;
    quantity: number;
    amount_total: number;
  }>;
  transactions: Array<{
    payment_intent_id: string;
    charge_id: string;
    amount: number;
    currency: string;
    created: number;
    customer_email: string;
    receipt_url: string;
  }>;
}

async function makeStripeRequest(
  url: string,
  stripeSecret: string,
): Promise<any> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Stripe API error: ${response.status} ${
        response.statusText
      }- ${await response.text()}`,
    );
  }

  return response.json();
}

async function getAllPaymentLinks(
  stripeSecret: string,
): Promise<StripePaymentLink[]> {
  const allPaymentLinks: StripePaymentLink[] = [];
  let hasMore = true;
  let startingAfter: string | null = null;

  while (hasMore) {
    const url = new URL("https://api.stripe.com/v1/payment_links");
    url.searchParams.append("active", "true");
    url.searchParams.append("limit", "100");
    url.searchParams.append("expand[]", "data.line_items");

    if (startingAfter) {
      url.searchParams.append("starting_after", startingAfter);
    }

    const data = await makeStripeRequest(url.toString(), stripeSecret);

    allPaymentLinks.push(...data.data);

    hasMore = data.has_more;
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id;
    }
  }

  return allPaymentLinks;
}

async function getCheckoutSessionsForPaymentLink(
  paymentLinkId: string,
  stripeSecret: string,
): Promise<StripeCheckoutSession[]> {
  const allSessions: StripeCheckoutSession[] = [];
  let hasMore = true;
  let startingAfter: string | null = null;

  while (hasMore) {
    const url = new URL("https://api.stripe.com/v1/checkout/sessions");
    url.searchParams.append("payment_link", paymentLinkId);
    url.searchParams.append("limit", "100");
    url.searchParams.append("expand[]", "data.payment_intent");
    url.searchParams.append("expand[]", "data.payment_intent.charges");

    if (startingAfter) {
      url.searchParams.append("starting_after", startingAfter);
    }

    const data = await makeStripeRequest(url.toString(), stripeSecret);

    allSessions.push(...data.data);

    hasMore = data.has_more;
    if (hasMore && data.data.length > 0) {
      startingAfter = data.data[data.data.length - 1].id;
    }
  }

  return allSessions;
}

function processPaymentLink(
  paymentLink: StripePaymentLink,
  checkoutSessions: StripeCheckoutSession[],
): PaymentLinkWithCharges {
  const transactions: PaymentLinkWithCharges["transactions"] = [];

  // Process checkout sessions to extract successful charges
  for (const session of checkoutSessions) {
    if (session.payment_status === "paid" && session.payment_intent) {
      for (const charge of session.payment_intent.charges.data) {
        if (charge.status === "succeeded") {
          transactions.push({
            payment_intent_id: session.payment_intent.id,
            charge_id: charge.id,
            amount: charge.amount,
            currency: charge.currency,
            created: charge.created,
            customer_email: charge.billing_details.email || "",
            receipt_url: charge.receipt_url || "",
          });
        }
      }
    }
  }

  return {
    id: paymentLink.id,
    url: paymentLink.url,
    active: paymentLink.active,
    line_items: paymentLink.line_items.data.map((item) => ({
      id: item.id,
      description: item.description,
      price_id: item.price.id,
      product_name: item.price.product.name,
      quantity: item.quantity,
      amount_total: item.amount_total,
    })),
    transactions,
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname;

    if (
      hostname === "openstripedashboard.com" ||
      hostname === "www.openstripedashboard.com"
    ) {
      return new Response(null, {
        status: 301,
        headers: { Location: "https://plrev.wilmake.com" },
      });
    }
    try {
      // Extract Authorization header
      const authHeader = request.headers.get("Authorization");

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({
            error: "Missing or invalid Authorization header",
            message:
              "Please provide Stripe secret key as 'Bearer sk_...' in Authorization header",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      const stripeSecret = authHeader.replace("Bearer ", "");

      // Validate that it looks like a Stripe secret key
      if (!stripeSecret.startsWith("sk_")) {
        return new Response(
          JSON.stringify({
            error: "Invalid Stripe secret key format",
            message: "Stripe secret key should start with 'sk_'",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      console.log("Fetching all active payment links...");

      // Get all active payment links
      const paymentLinks = await getAllPaymentLinks(stripeSecret);
      console.log(`Found ${paymentLinks.length} active payment links`);

      const results: PaymentLinkWithCharges[] = [];

      // Process each payment link
      for (const paymentLink of paymentLinks) {
        console.log(`Processing payment link: ${paymentLink.id}`);

        // Get checkout sessions for this payment link
        const checkoutSessions = await getCheckoutSessionsForPaymentLink(
          paymentLink.id,
          stripeSecret,
        );
        console.log(
          `Found ${checkoutSessions.length} checkout sessions for ${paymentLink.id}`,
        );

        // Process and add to results
        const processedLink = processPaymentLink(paymentLink, checkoutSessions);
        results.push(processedLink);

        console.log(
          `Payment link ${paymentLink.id} has ${processedLink.transactions.length} successful transactions`,
        );
      }

      // Calculate summary statistics
      const totalTransactions = results.reduce(
        (sum, link) => sum + link.transactions.length,
        0,
      );
      const totalRevenue = results.reduce(
        (sum, link) =>
          sum +
          link.transactions.reduce(
            (linkSum, transaction) => linkSum + transaction.amount,
            0,
          ),
        0,
      );

      const summary = {
        total_active_payment_links: results.length,
        total_successful_transactions: totalTransactions,
        total_revenue_cents: totalRevenue,
        payment_links: results,
      };

      return new Response(JSON.stringify(summary, null, 2), {
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("Error processing payment links:", error);

      return new Response(
        JSON.stringify({
          error: "Failed to process payment links",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }
  },
};
