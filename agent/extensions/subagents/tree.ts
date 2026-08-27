export type TreeItem = {
	id: string;
	parentId?: string;
	createdAt: number;
	active: boolean;
};

export type TreeRow<T extends TreeItem> = {
	item: T;
	prefix: string;
	isLast: boolean;
};

export type VisibleTree<T extends TreeItem> = {
	rows: TreeRow<T>[];
	visibleCount: number;
	omitted: number;
};

/** Count hierarchy levels without treating synthetic tree rows as parents. */
export function buildHierarchyLevels(items: Array<Pick<TreeItem, "id" | "parentId">>): Map<string, number> {
	const byId = new Map(items.map((item) => [item.id, item]));
	const levels = new Map<string, number>();
	for (const item of items) {
		let level = 1;
		let parentId = item.parentId;
		const seen = new Set([item.id]);
		while (parentId && !seen.has(parentId)) {
			level++;
			seen.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
		levels.set(item.id, level);
	}
	return levels;
}

/** Keep every active node and its known ancestors, then render a bounded depth-first tree. */
export function buildVisibleTree<T extends TreeItem>(items: T[], maxRows: number): VisibleTree<T> {
	const byId = new Map(items.map((item) => [item.id, item]));
	const visibleIds = new Set(items.filter((item) => item.active).map((item) => item.id));
	for (const item of items) {
		if (!item.active) continue;
		let parentId = item.parentId;
		const seen = new Set<string>();
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) break;
			visibleIds.add(parent.id);
			parentId = parent.parentId;
		}
	}
	const visible = items.filter((item) => visibleIds.has(item.id));
	const children = new Map<string | undefined, T[]>();
	for (const item of visible) {
		let parentId = item.parentId && visibleIds.has(item.parentId) ? item.parentId : undefined;
		if (parentId) {
			const seen = new Set([item.id]);
			let cursor: string | undefined = parentId;
			while (cursor) {
				if (seen.has(cursor)) {
					parentId = undefined;
					break;
				}
				seen.add(cursor);
				const parent = byId.get(cursor);
				cursor = parent?.parentId && visibleIds.has(parent.parentId) ? parent.parentId : undefined;
			}
		}
		const siblings = children.get(parentId) ?? [];
		siblings.push(item);
		children.set(parentId, siblings);
	}
	for (const siblings of children.values()) siblings.sort((left, right) => left.createdAt - right.createdAt);
	const rows: TreeRow<T>[] = [];
	const walk = (item: T, prefix: string, isLast: boolean): void => {
		if (rows.length >= maxRows) return;
		rows.push({ item, prefix, isLast });
		const nested = children.get(item.id) ?? [];
		for (const [index, child] of nested.entries()) {
			walk(child, `${prefix}${isLast ? "   " : "│  "}`, index === nested.length - 1);
		}
	};
	const roots = children.get(undefined) ?? [];
	for (const [index, root] of roots.entries()) walk(root, "", index === roots.length - 1);
	return { rows, visibleCount: visible.length, omitted: Math.max(0, visible.length - rows.length) };
}
