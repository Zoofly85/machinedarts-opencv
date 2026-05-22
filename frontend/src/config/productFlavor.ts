export type ProductFlavor = "home" | "opencv" | "club-board" | "club-master";
export type AppShell = "home" | "club-board" | "club-master";

type FlavorConfig = {
  flavor: ProductFlavor;
  shell: AppShell;
  productName: string;
  defaultRoute: string;
};

const _rawFlavor = String(import.meta.env.VITE_MACHINE_DARTS_FLAVOR || "home").trim().toLowerCase();

function normalizeFlavor(value: string): ProductFlavor {
  if (value === "opencv") return "opencv";
  if (value === "club-board") return "club-board";
  if (value === "club-master") return "club-master";
  return "home";
}

export const PRODUCT_FLAVOR: ProductFlavor = normalizeFlavor(_rawFlavor);

const FLAVOR_CONFIG: Record<ProductFlavor, FlavorConfig> = {
  home: {
    flavor: "home",
    shell: "home",
    productName: "Machine Darts Home",
    defaultRoute: "/",
  },
  opencv: {
    flavor: "opencv",
    shell: "home",
    productName: "Machine Darts OpenCV",
    defaultRoute: "/",
  },
  "club-board": {
    flavor: "club-board",
    shell: "club-board",
    productName: "Machine Darts Club Board",
    defaultRoute: "/kiosk",
  },
  "club-master": {
    flavor: "club-master",
    shell: "club-master",
    productName: "Machine Darts Club Master",
    defaultRoute: "/club/master",
  },
};

export function getFlavorConfig(): FlavorConfig {
  return FLAVOR_CONFIG[PRODUCT_FLAVOR];
}

