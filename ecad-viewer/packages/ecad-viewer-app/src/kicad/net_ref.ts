export type LabelKind = "global" | "net" | "hierarchical" | "sheet-pin";

export class NetRef {
    constructor(
        public readonly sheet_name: string,
        public readonly name: string,
        public readonly uuid: string,
        public readonly kind?: LabelKind,
    ) {}
}
