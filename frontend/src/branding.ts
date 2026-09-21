// IHSM CENTRAL and IHSM ELITE deliberately share one logo image - every
// place a logo is shown always pairs it with the full college name as text
// right next to it, which is what actually disambiguates the two, not the
// image itself.
const COLLEGE_LOGOS: Record<string, string> = {
    "KRMA CENTRAL": "/logos/ksma.png",
    "IHSM CENTRAL": "/logos/ihsm.png",
    "IHSM ELITE": "/logos/ihsm.png",
};

export const ISM_EDUTECH_LOGO = "/logos/ism-edutech.png";

export function collegeLogo(collegeName: string): string | undefined {
    return COLLEGE_LOGOS[collegeName];
}
