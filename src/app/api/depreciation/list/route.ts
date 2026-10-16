import {depreciationDispatch} from '@/features/depreciation/server';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(r:Request){return depreciationDispatch('list',r);}
