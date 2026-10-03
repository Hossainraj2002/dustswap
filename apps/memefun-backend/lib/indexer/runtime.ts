import { chainSettings } from "../chain";
import { loadDeployment } from "../deployment";
import { envList } from "../env";
import { indexerAddresses } from "./addresses";

/** The deployment the indexer runs against, resolved once from MEMEFUN_CHAIN. */
export const chain = chainSettings();
export const deployment = loadDeployment(chain.id);
/** MEMEFUN_EXTRA_ROUTERS: more router contracts whose trades are attributed to the tx sender. */
export const addresses = indexerAddresses(deployment, envList("MEMEFUN_EXTRA_ROUTERS"));
