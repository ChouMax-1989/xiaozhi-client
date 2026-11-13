import { GithubIcon, QQIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavLink } from "react-router-dom";
import { VersionDisplay } from "./version-display";

export function SiteHeader({ title }: { title: string }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      <h1 className="mr-2 text-base font-medium">{title}</h1>
      <nav aria-label="主导航" className="flex items-center gap-1">
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            cn(
              buttonVariants({
                variant: isActive ? "secondary" : "ghost",
                size: "sm",
              })
            )
          }
        >
          看板
        </NavLink>
        <NavLink
          to="/memory"
          className={({ isActive }) =>
            cn(
              buttonVariants({
                variant: isActive ? "secondary" : "ghost",
                size: "sm",
              })
            )
          }
        >
          记忆库
        </NavLink>
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <div className="hidden sm:block">
          <VersionDisplay />
        </div>
        <a
          href="https://qun.qq.com/universal-share/share?ac=1&authKey=c08PvS2zvAF1NN%2F%2BuaOi0ze1AElTIsvFBLwbWUMFc2ixjaZYxqZTUQHzipwd8Kka&busi_data=eyJncm91cENvZGUiOiIxMDU0ODg4NDczIiwidG9rZW4iOiJuSmJUN2cyUEVkNEQ5WXovM3RQbFVNcDluMGVibUNZTUQvL1RuQnFJRjBkZmRZQnRBRTdwU0szL3V2Y0dLc1ZmIiwidWluIjoiMzkxMTcyMDYwMCJ9&data=9cH6_zEC-sN3xYlwzKEWiYF71RLY9CId5taN-gy6XZo7axSlSWDpd1Ojui5hYMQKIgEJYSPw59XYgF5vH2wLog&svctype=4&tempid=h5_group_info"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="加入 QQ 交流群"
        >
          <QQIcon size={24} className="text-slate-800" fill="currentColor" />
        </a>
        <a
          href="https://github.com/shenjingnan/xiaozhi-client"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="查看 GitHub 仓库"
        >
          <GithubIcon
            size={24}
            className="text-slate-800"
            fill="currentColor"
          />
        </a>
      </div>
    </header>
  );
}
