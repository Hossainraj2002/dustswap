import { onRequestDelete as __api_admin_auth_js_onRequestDelete } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/auth.js"
import { onRequestPost as __api_admin_auth_js_onRequestPost } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/auth.js"
import { onRequestDelete as __api_admin_file_js_onRequestDelete } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/file.js"
import { onRequestGet as __api_admin_file_js_onRequestGet } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/file.js"
import { onRequestPut as __api_admin_file_js_onRequestPut } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/file.js"
import { onRequestGet as __api_admin_files_js_onRequestGet } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/api/admin/files.js"
import { onRequestGet as __admin_index_js_onRequestGet } from "/sessions/dazzling-intelligent-rubin/mnt/dustswap/docs/functions/admin/index.js"

export const routes = [
    {
      routePath: "/api/admin/auth",
      mountPath: "/api/admin",
      method: "DELETE",
      middlewares: [],
      modules: [__api_admin_auth_js_onRequestDelete],
    },
  {
      routePath: "/api/admin/auth",
      mountPath: "/api/admin",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_auth_js_onRequestPost],
    },
  {
      routePath: "/api/admin/file",
      mountPath: "/api/admin",
      method: "DELETE",
      middlewares: [],
      modules: [__api_admin_file_js_onRequestDelete],
    },
  {
      routePath: "/api/admin/file",
      mountPath: "/api/admin",
      method: "GET",
      middlewares: [],
      modules: [__api_admin_file_js_onRequestGet],
    },
  {
      routePath: "/api/admin/file",
      mountPath: "/api/admin",
      method: "PUT",
      middlewares: [],
      modules: [__api_admin_file_js_onRequestPut],
    },
  {
      routePath: "/api/admin/files",
      mountPath: "/api/admin",
      method: "GET",
      middlewares: [],
      modules: [__api_admin_files_js_onRequestGet],
    },
  {
      routePath: "/admin",
      mountPath: "/admin",
      method: "GET",
      middlewares: [],
      modules: [__admin_index_js_onRequestGet],
    },
  ]