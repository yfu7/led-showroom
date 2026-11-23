/**
 * The Veloxity wordmark, from the header of veloxity.us, for the drawing sheet's title strip.
 * One filled path; the file keeps the site's blue.
 */
import svg from '../../assets/veloxity-logo.svg?raw';

const box = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number) ?? [0, 0, 126, 28];
export const LOGO_W = box[2];
export const LOGO_H = box[3];
export const LOGO_PATH = /\sd="([^"]+)"/.exec(svg)?.[1] ?? '';
export const LOGO_COLOR = /fill="(#[0-9a-fA-F]{6})"/.exec(svg)?.[1] ?? '#28ACE3';
