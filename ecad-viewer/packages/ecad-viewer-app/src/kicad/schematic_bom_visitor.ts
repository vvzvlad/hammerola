import type { DesignatorRef } from "./board_bom_visitor";
import type { BomItem } from "./bom_item";
import {
    SchematicInstanceContext,
    type KicadSch,
    type SchematicSymbol,
} from "./schematic";
import { SchematicVisitorBase } from "./schematic_visitor_base";

export class SchematicBomVisitor extends SchematicVisitorBase {
    #bom_list: BomItem[] = [];
    #designator_refs = new Map<string, DesignatorRef[]>();
    #current_sch_file: string;
    #context?: SchematicInstanceContext;
    #existing_designators = new Set<string>();

    public constructor() {
        super();
    }

    get bom_list() {
        return this.#bom_list;
    }

    get designator_refs() {
        return this.#designator_refs;
    }

    visitKicadSch(sheet: KicadSch) {
        this.#current_sch_file = sheet.filename;
        if (this.#context?.document !== sheet) {
            this.#context = undefined;
        }
    }

    visit_instance(context: SchematicInstanceContext) {
        this.#context = context;
        this.visit(context.document);
    }

    visitSchematicSymbol(node: SchematicSymbol) {
        const context = this.#context;
        const excluded_from_bom = context
            ? context.excluded_from_bom(node)
            : !node.in_bom;
        if (
            (context?.footprint(node) ?? node.footprint).length == 0 ||
            excluded_from_bom
        )
            return;

        const value = context?.value(node) ?? node.value;
        const footprint = context?.footprint(node) ?? node.footprint;
        const reference = context?.reference(node) ?? node.reference;
        const unit = context?.unit(node) ?? node.unit;

        const schematicSymbol: BomItem = {
            Reference: "",
            Name: value,
            Description:
                context?.property_text(node, "Description") ??
                node.get_property_text("Description") ??
                "",
            Datasheet:
                context?.property_text(node, "Datasheet") ?? node.datasheet,
            Footprint: footprint,
            DNP: context?.dnp(node) ?? node.dnp,
            Qty: 1,
            Price: 0,
        };

        const Reference = reference;

        if (Reference.endsWith("?")) return;

        if (!this.#existing_designators.has(Reference)) {
            this.#existing_designators.add(Reference);

            this.#bom_list.push({
                ...schematicSymbol,
                Reference,
                Name: value ?? schematicSymbol.Name,
                Footprint: footprint ?? schematicSymbol.Footprint,
            });
        }

        const existing_refs = this.#designator_refs.get(Reference) ?? [];
        existing_refs.push({
            uuid: node.uuid,
            sheet_name: this.#current_sch_file,
            unit,
            sheet_path: this.#context?.sheet_path,
            project_path: this.#context?.project_path,
        });
        this.#designator_refs.set(Reference, existing_refs);
    }
}
