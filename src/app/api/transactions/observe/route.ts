import { transactionDispatch } from '@/features/transactions/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(r: Request) { return transactionDispatch('observe', r); }
