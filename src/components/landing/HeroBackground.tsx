import React from 'react';

/**
 * Hero background — the specified Pexels photograph (photo id 38892300).
 *
 * The file is requested through Pexels' own CDN transform of the *same* photo
 * so the browser downloads ~160 KB instead of the 1.7 MB master. The image is
 * never substituted or regenerated.
 *
 * The photograph is a very dark, moody night scene (median luminance ≈ 8/255)
 * with warm structural highlights centred horizontally and in the middle-to-
 * lower frame, so `background-position: center 45%` keeps the lit structures
 * in view. Positioning and overlays live in `src/index.css` (`.ws-hero-bg*`).
 */
const HERO_PHOTO = 'https://images.pexels.com/photos/38892300/pexels-photo-38892300.jpeg';
export const HERO_IMAGE_2X = `${HERO_PHOTO}?auto=compress&cs=tinysrgb&w=1920`;

export const HeroBackground: React.FC = () => (
  <div className="ws-hero-bg" aria-hidden="true">
    <div className="ws-hero-bg__image" />
    <div className="ws-hero-bg__navy" />
    <div className="ws-hero-bg__scrim" />
    <div className="ws-hero-bg__tint" />
    <div className="ws-hero-bg__top" />
    <div className="ws-hero-bg__fade" />
  </div>
);
