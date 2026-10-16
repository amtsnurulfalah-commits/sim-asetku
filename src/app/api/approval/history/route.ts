import { approvalDispatch } from '@/features/approval/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(r: Request) { return approvalDispatch('history', r); }
