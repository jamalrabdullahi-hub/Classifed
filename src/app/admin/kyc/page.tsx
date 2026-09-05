import Link from 'next/link';
import { kycQueue } from '@/services/admin';
import { KycDecision } from '@/components/admin/KycDecision';

export const dynamic = 'force-dynamic';

/**
 * KYC review queue, oldest submission first — the customer who has waited
 * longest is the one being kept out of the product.
 */
export default async function AdminKyc() {
  const queue = await kycQueue();

  return (
    <>
      <h1>KYC review</h1>

      {queue.length === 0 ? (
        <p className="muted">Nothing waiting for review.</p>
      ) : (
        queue.map((p) => (
          <div className="card" key={p.id}>
            <div className="row">
              <div>
                <strong>{p.fullName}</strong> <span className="pill">{p.status}</span>
                <div className="muted">
                  <Link href={`/admin/users/${p.userId}`}>{p.user.email}</Link>
                  {p.user.phone ? ` · ${p.user.phone}` : null}
                </div>
                <div className="muted">
                  {p.nationality} · resident {p.country} · {p.documentType} · via {p.provider}
                </div>
              </div>
              <div className="muted">
                {p.submittedAt ? `submitted ${p.submittedAt.toISOString().slice(0, 10)}` : 'not submitted'}
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <KycDecision userId={p.userId} />
            </div>
          </div>
        ))
      )}
    </>
  );
}
