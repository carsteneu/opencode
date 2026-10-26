import HomeFooter from "../feature-plugins/home/footer"
import PromptBtw from "../feature-plugins/prompt/btw"
import PromptFooter from "../feature-plugins/prompt/footer"
import PromptHomeEnd from "../feature-plugins/prompt/home-end"
import PromptTokensPerSecond from "../feature-plugins/prompt/tokens-per-second"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarFooterIdentity from "../feature-plugins/sidebar/footer-identity"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarNotes from "../feature-plugins/sidebar/notes"
import SidebarTitleRename from "../feature-plugins/sidebar/title-rename"
import SidebarTodo from "../feature-plugins/sidebar/todo"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Plugins from "../feature-plugins/system/plugins"
import Storybook from "../feature-plugins/system/storybook"
import Stats from "../feature-plugins/system/stats"
import Latex from "@opencode/latex/plugin"
import Merman from "@opencode/merman/plugin"

export const builtins = [
  HomeFooter,
  PromptFooter,
  PromptBtw,
  SidebarContext,
  SidebarMcp,
  SidebarTodo,
  SidebarFooter,
  Notifications,
  Plugins,
  Stats,
  Merman,
  Latex,
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for OPENCODE_STORY runs.
  ...(process.env.OPENCODE_STORY ? [Storybook] : []),
  DiffViewer,
  // The fork's own UI plugins. They used to be loaded from the user's plugin directory, so they sat
  // after every stock builtin; keeping them at the tail preserves that claim order (slot appends are
  // resolved in registration order) and ships them with the package instead of as an install step.
  // Migration: a leftover copy in <config>/plugins/<name> is keyed by the same plugin id and therefore
  // replaces the builtin entry instead of rendering twice - deleting the copy is what activates the builtin.
  PromptHomeEnd,
  PromptTokensPerSecond,
  SidebarFooterIdentity,
  SidebarTitleRename,
  SidebarNotes,
]
