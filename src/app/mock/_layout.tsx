import { Redirect, Slot } from 'expo-router';

/** 统一保护全部 mock 子路由，新增预览页也不能绕过开发环境限制。 */
export default function MockLayout() {
  return __DEV__ ? <Slot /> : <Redirect href="/" />;
}
