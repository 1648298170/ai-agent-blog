// components/NavBar.tsx —— 顶部导航（三页）+ 响应式：
// 桌面端顶栏链接（md:flex），移动端底部 tab（fixed bottom，触达区 64px ≥ 40px 触控标准）
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "智能对话" },
  { href: "/kb", label: "知识库" },
  { href: "/service", label: "智能客服" },
] as const;

export default function NavBar() {
  const pathname = usePathname();
  const isActive = (href: string): boolean =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* 桌面端：顶栏内导航 */}
      <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(link.href) ? "page" : undefined}
            className={`flex min-h-10 items-center rounded-lg px-3 text-sm font-medium transition-colors ${
              isActive(link.href)
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* 移动端：底部 tab 栏（h-16 = 64px 触达区） */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white/95 backdrop-blur md:hidden"
        aria-label="移动端导航"
      >
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive(link.href) ? "page" : undefined}
            className={`flex h-16 flex-1 items-center justify-center text-sm font-medium ${
              isActive(link.href) ? "text-blue-600" : "text-gray-500"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
