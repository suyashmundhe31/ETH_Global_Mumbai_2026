// Businesses manage campaigns in business-frontend (create a campaign, publish its creatures to Arkiv, and
// approve claims: CreatureMarket records the claim, the business moves the Arkiv entity to the player).
// The old CRE "settle catches" page lived here; CRE is gone, so this only points there.

const BUSINESS_APP_URL = process.env.NEXT_PUBLIC_BUSINESS_APP_URL || "";

export default function BusinessPage() {
  return (
    <main className="page">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>Business</h1>
            <p>Campaigns, publishing creatures to Arkiv and approving claims are done in the business app.</p>
          </div>
          {BUSINESS_APP_URL && (
            <a href={BUSINESS_APP_URL} className="btn btn-primary">
              Open the business app
            </a>
          )}
        </header>
      </div>
    </main>
  );
}
