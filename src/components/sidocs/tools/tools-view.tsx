"use client";

import { AllToolsView } from "@/components/sidocs/tools/all-tools-view";
import { CategoryView } from "@/components/sidocs/tools/category-view";
import {
  CATEGORIES,
  type ToolCategoryId,
} from "@/lib/tools/registry";

/**
 * Tools route view: renders the All Tools page or a category page based on
 * the hash route. Keyed by the route query so palette "see all results"
 * navigation remounts the view with the new search term.
 */
export function ToolsView({
  categoryId,
  query,
}: {
  categoryId?: string;
  query?: string;
}) {
  const validCategory = CATEGORIES.find(
    (category) => category.id === categoryId
  );

  if (validCategory) {
    return <CategoryView categoryId={validCategory.id as ToolCategoryId} />;
  }

  return <AllToolsView key={query ?? ""} initialQuery={query ?? ""} />;
}
