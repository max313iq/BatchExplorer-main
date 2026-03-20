function chunkNodeIds(nodeIds: string[], maxPerRequest = 100): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < nodeIds.length; i += maxPerRequest) {
        chunks.push(nodeIds.slice(i, i + maxPerRequest));
    }
    return chunks;
}

describe("BatchNodeActions chunking safety", () => {
    it("never generates a chunk above 100 node IDs", () => {
        const ids = Array.from({ length: 245 }, (_, i) => `node-${i}`);
        const chunks = chunkNodeIds(ids, 100);

        expect(chunks.length).toBe(3);
        expect(chunks[0].length).toBe(100);
        expect(chunks[1].length).toBe(100);
        expect(chunks[2].length).toBe(45);
        expect(chunks.every(x => x.length <= 100)).toBe(true);
    });

    it("keeps ordering stable across chunks", () => {
        const ids = ["n-1", "n-2", "n-3", "n-4"];
        const chunks = chunkNodeIds(ids, 2);
        const flattened = chunks.reduce((acc, chunk) => acc.concat(chunk), [] as string[]);

        expect(flattened).toEqual(ids);
    });
});
