import { createNavigationContainerRef } from '@react-navigation/native';

export const navRef = createNavigationContainerRef<any>();
export function navigate(name: string, params?: object) {
  if (navRef.isReady()) navRef.navigate(name, params);
}
