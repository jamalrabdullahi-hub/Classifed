import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from './reset-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('titleNewPassword') };
}
export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token ?? null} />;
}
