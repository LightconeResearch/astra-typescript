// Read-only lookups and structural validation over project-view-model.v1.

import type {
  AstraRecordKind,
  ProjectRecordReference,
  ProjectRecordView,
  ProjectScopeView,
  ProjectViewModelV1,
  ResourceDescriptor,
  ViewModelDiagnostic,
} from "./types.js";

export interface LocatedProjectRecord {
  record: ProjectRecordView;
  scope: ProjectScopeView;
}

export interface ProjectViewModelIndex {
  model: ProjectViewModelV1;
  scopeById: ReadonlyMap<string, ProjectScopeView>;
  scopeByPath: ReadonlyMap<string, ProjectScopeView>;
  recordById: ReadonlyMap<string, ProjectRecordView>;
  recordByPath: ReadonlyMap<string, LocatedProjectRecord>;
  recordsByLocalId: ReadonlyMap<string, readonly LocatedProjectRecord[]>;
  resourceById: ReadonlyMap<string, ResourceDescriptor>;
}

export function createProjectViewModelIndex(
  model: ProjectViewModelV1,
  extraResources: readonly ResourceDescriptor[] = [],
): ProjectViewModelIndex {
  const scopeById = new Map(model.scopes.map((scope) => [scope.id, scope]));
  const scopeByPath = new Map(
    model.scopes.map((scope) => [scope.canonicalPath, scope]),
  );
  const recordById = new Map(model.records.map((record) => [record.id, record]));
  const recordByPath = new Map<string, LocatedProjectRecord>();
  const recordsByLocalId = new Map<string, LocatedProjectRecord[]>();

  for (const record of model.records) {
    const scope = scopeById.get(record.scopeId);
    if (!scope) continue;
    const located = { record, scope };
    recordByPath.set(record.canonicalPath, located);
    const matches = recordsByLocalId.get(record.localId) ?? [];
    matches.push(located);
    recordsByLocalId.set(record.localId, matches);
  }

  const resourceById = new Map(
    [...model.resources, ...extraResources].map((resource) => [resource.id, resource]),
  );

  return {
    model,
    scopeById,
    scopeByPath,
    recordById,
    recordByPath,
    recordsByLocalId,
    resourceById,
  };
}

export function recordsForScope(
  index: ProjectViewModelIndex,
  scopeId: string,
  kind?: AstraRecordKind,
): ProjectRecordView[] {
  const scope = index.scopeById.get(scopeId);
  if (!scope) return [];
  return scope.recordIds
    .map((id) => index.recordById.get(id))
    .filter((record): record is ProjectRecordView =>
      Boolean(record && (!kind || record.kind === kind)),
    );
}

export function resolveProjectRecord(
  index: ProjectViewModelIndex,
  reference: ProjectRecordReference | string,
  scopeId?: string,
): LocatedProjectRecord | undefined {
  const canonicalPath = typeof reference === "string"
    ? reference
    : reference.canonicalPath ?? reference.path;
  const exact = canonicalPath ? index.recordByPath.get(canonicalPath) : undefined;
  if (exact) return exact;

  const id = typeof reference === "string" ? reference : reference.id;
  const direct = index.recordById.get(id);
  if (direct) {
    const scope = index.scopeById.get(direct.scopeId);
    return scope ? { record: direct, scope } : undefined;
  }

  const candidates = index.recordsByLocalId.get(id) ?? [];
  const kind = typeof reference === "string" ? undefined : reference.kind;
  const matches = candidates.filter(({ record, scope }) =>
    (!kind || record.kind === kind) && (!scopeId || scope.id === scopeId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function validateProjectViewModel(
  model: ProjectViewModelV1,
): ViewModelDiagnostic[] {
  const diagnostics: ViewModelDiagnostic[] = [];
  const scopeIds = new Set<string>();
  const recordIds = new Set<string>();
  const recordPaths = new Set<string>();
  const resourceIds = new Set<string>();

  for (const scope of model.scopes) {
    if (scopeIds.has(scope.id)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_scope_id",
        message: `Duplicate view scope id: ${scope.id}`,
        canonicalPath: scope.canonicalPath,
      });
    }
    scopeIds.add(scope.id);
  }

  for (const scope of model.scopes) {
    if (scope.parentId && !scopeIds.has(scope.parentId)) {
      diagnostics.push({
        severity: "error",
        code: "missing_parent_scope",
        message: `Scope ${scope.id} refers to missing parent ${scope.parentId}.`,
        canonicalPath: scope.canonicalPath,
      });
    }
    for (const childId of scope.childIds) {
      if (!scopeIds.has(childId)) {
        diagnostics.push({
          severity: "error",
          code: "missing_child_scope",
          message: `Scope ${scope.id} refers to missing child ${childId}.`,
          canonicalPath: scope.canonicalPath,
        });
      }
    }
  }

  for (const resource of model.resources) {
    if (resourceIds.has(resource.id)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_resource_id",
        message: `Duplicate resource id: ${resource.id}`,
      });
    }
    resourceIds.add(resource.id);
  }

  for (const record of model.records) {
    if (recordIds.has(record.id)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_record_id",
        message: `Duplicate view record id: ${record.id}`,
        canonicalPath: record.canonicalPath,
      });
    }
    recordIds.add(record.id);
    if (recordPaths.has(record.canonicalPath)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_record_path",
        message: `Duplicate canonical record path: ${record.canonicalPath}`,
        canonicalPath: record.canonicalPath,
      });
    }
    recordPaths.add(record.canonicalPath);
    if (!scopeIds.has(record.scopeId)) {
      diagnostics.push({
        severity: "error",
        code: "missing_record_scope",
        message: `Record ${record.id} refers to missing scope ${record.scopeId}.`,
        canonicalPath: record.canonicalPath,
      });
    }
    if (record.kind === "output") {
      for (const resourceId of record.resourceIds) {
        if (!resourceIds.has(resourceId)) {
          diagnostics.push({
            severity: "warning",
            code: "missing_resource_descriptor",
            message: `Output ${record.canonicalPath} refers to unknown resource ${resourceId}.`,
            canonicalPath: record.canonicalPath,
          });
        }
      }
    }
    for (const relation of record.relations) {
      if (!recordIds.has(relation.targetRecordId)
        && !model.records.some((candidate) => candidate.id === relation.targetRecordId)) {
        diagnostics.push({
          severity: "warning",
          code: "missing_relation_target",
          message: `Record ${record.canonicalPath} refers to unknown record ${relation.targetRecordId}.`,
          canonicalPath: record.canonicalPath,
        });
      }
    }
  }

  for (const resource of model.resources) {
    if (resource.outputRecordId) {
      const output = model.records.find(
        (record) => record.id === resource.outputRecordId && record.kind === "output",
      );
      if (!output) {
        diagnostics.push({
          severity: "warning",
          code: "missing_resource_output",
          message: `Resource ${resource.id} refers to unknown output ${resource.outputRecordId}.`,
        });
      }
    }
  }

  for (const scope of model.scopes) {
    for (const recordId of scope.recordIds) {
      const record = model.records.find((candidate) => candidate.id === recordId);
      if (!record || record.scopeId !== scope.id) {
        diagnostics.push({
          severity: "error",
          code: "invalid_scope_record",
          message: `Scope ${scope.id} contains invalid record id ${recordId}.`,
          canonicalPath: scope.canonicalPath,
        });
      }
    }
  }

  return diagnostics;
}
