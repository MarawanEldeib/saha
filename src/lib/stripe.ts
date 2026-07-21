import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
    if (!_stripe) {
        _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
            apiVersion: "2026-04-22.dahlia",
        });
    }
    return _stripe;
}

export const PLATFORM_FEE_PERCENT = 10;

/**
 * SAH-64: surface whether the deployment is talking to Stripe test mode.
 * Server-only — never bake the key prefix into a client bundle.
 * Test-mode keys start with `sk_test_`; live keys start with `sk_live_`.
 * Returns true for test, false for live, and false when the env is unset
 * (we can't make a safe assumption either way, so default to "production"
 * to avoid showing the banner in production by accident).
 */
export function isStripeTestMode(): boolean {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    return key.startsWith("sk_test_");
}
