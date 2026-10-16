import { transactionDispatch } from '@/features/transactions/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(r: Request) { return transactionDispatch('scan', r); }
