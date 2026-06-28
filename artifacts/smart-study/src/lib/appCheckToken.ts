import { getToken, type AppCheck } from 'firebase/app-check';

let _instance: AppCheck | null = null;

export function setAppCheck(ac: AppCheck): void {
  _instance = ac;
}

export async function getAppCheckToken(): Promise<string | null> {
  if (!_instance) return null;
  try {
    const result = await getToken(_instance, false);
    return result.token;
  } catch {
    return null;
  }
}
