import { approvalDispatch } from '@/features/approval/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(r: Request) { return approvalDispatch('return', r); }
