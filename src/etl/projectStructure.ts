import {
    DEFAULT_CONTAINER_HEIGHT,
    DEFAULT_CONTAINER_WIDTH,
    ETL_PROJECT_FORMAT_VERSION,
    ContainerNodeConfig,
    EtlConnection,
    EtlNode,
    EtlProject,
    Position,
} from './etlTypes';

export interface PositionedNode {
    id: string;
    position: Position;
}

function cloneNode(node: EtlNode): EtlNode {
    return {
        ...node,
        position: { ...node.position },
        config: node.config.type === 'container'
            ? { ...node.config, nodes: undefined, connections: undefined }
            : { ...node.config },
    } as EtlNode;
}

function cloneConnection(connection: EtlConnection): EtlConnection {
    return {
        ...connection,
        ...(connection.boundary ? { boundary: { ...connection.boundary } } : {}),
    };
}

export function isContainerNode(node: EtlNode | undefined): node is EtlNode & { config: ContainerNodeConfig } {
    return !!node && node.type === 'container' && node.config.type === 'container';
}

export function getContainerMembers(project: EtlProject, containerId: string): EtlNode[] {
    return project.nodes.filter(node => node.containerId === containerId);
}

export function getContainerChildCount(project: EtlProject, containerId: string): number {
    return getContainerMembers(project, containerId).length;
}

export function getLogicalConnectionEndpoints(connection: EtlConnection): Pick<EtlConnection, 'from' | 'to'> {
    return connection.boundary
        ? { from: connection.boundary.originalFrom, to: connection.boundary.originalTo }
        : { from: connection.from, to: connection.to };
}

/**
 * Recomputes the visible/executable endpoint of every connection from stable,
 * logical task endpoints and the current container membership.
 */
export function reconcileContainerBoundaries(project: EtlProject): EtlProject {
    const nodeById = new Map(project.nodes.map(node => [node.id, node]));
    const connections = project.connections.map(connection => {
        const logical = getLogicalConnectionEndpoints(connection);
        const sourceContainer = nodeById.get(logical.from)?.containerId;
        const targetContainer = nodeById.get(logical.to)?.containerId;

        if (sourceContainer === targetContainer) {
            return { ...connection, from: logical.from, to: logical.to, boundary: undefined };
        }

        const from = sourceContainer || logical.from;
        const to = targetContainer || logical.to;
        const crossesBoundary = from !== logical.from || to !== logical.to;
        return {
            ...connection,
            from,
            to,
            ...(crossesBoundary ? { boundary: { originalFrom: logical.from, originalTo: logical.to } } : { boundary: undefined }),
        };
    });

    return { ...project, connections };
}

function normalizeContainerConfig(config: ContainerNodeConfig): ContainerNodeConfig {
    return {
        type: 'container',
        width: Number.isFinite(config.width) ? config.width : DEFAULT_CONTAINER_WIDTH,
        height: Number.isFinite(config.height) ? config.height : DEFAULT_CONTAINER_HEIGHT,
    };
}

/**
 * Converts v1 nested container payloads to the flat v2 membership model.
 * Nested containers were never a supported execution scope and are rejected
 * explicitly instead of silently changing their semantics.
 */
export function normalizeEtlProject(project: EtlProject): EtlProject {
    const sourceNodes = Array.isArray(project.nodes) ? project.nodes : [];
    const sourceConnections = Array.isArray(project.connections) ? project.connections : [];
    const nodes: EtlNode[] = [];
    const connections = sourceConnections.map(cloneConnection);
    const nodeIds = new Set<string>();

    for (const node of sourceNodes) {
        if (nodeIds.has(node.id)) {
            throw new Error(`Duplicate node ID: ${node.id}`);
        }
        nodeIds.add(node.id);
        nodes.push(cloneNode(node));
    }

    for (const container of [...nodes]) {
        if (!isContainerNode(container)) continue;

        const original = sourceNodes.find(node => node.id === container.id);
        const legacyConfig = original?.config.type === 'container' ? original.config : undefined;
        container.config = normalizeContainerConfig(container.config);

        const legacyNodes = legacyConfig?.nodes || [];
        const legacyConnections = legacyConfig?.connections || [];
        for (const child of legacyNodes) {
            if (child.type === 'container') {
                throw new Error(`Nested container '${child.name}' is not supported in ETL project v2`);
            }
            if (nodeIds.has(child.id)) {
                throw new Error(`Container '${container.name}' contains duplicate node ID: ${child.id}`);
            }
            nodeIds.add(child.id);
            nodes.push({ ...cloneNode(child), containerId: container.id });
        }
        connections.push(...legacyConnections.map(cloneConnection));
    }

    for (const node of nodes) {
        if (node.containerId) {
            const owner = nodes.find(candidate => candidate.id === node.containerId);
            if (!isContainerNode(owner)) {
                throw new Error(`Task '${node.name}' references an invalid container: ${node.containerId}`);
            }
            if (node.type === 'container') {
                throw new Error(`Nested container '${node.name}' is not supported in ETL project v2`);
            }
        }
    }

    return reconcileContainerBoundaries({
        ...project,
        version: ETL_PROJECT_FORMAT_VERSION,
        nodes,
        connections,
    });
}

/** Returns the root execution graph, excluding children owned by containers. */
export function getRootExecutionProject(project: EtlProject): EtlProject {
    const nodes = project.nodes.filter(node => !node.containerId);
    const nodeIds = new Set(nodes.map(node => node.id));
    return {
        ...project,
        nodes,
        connections: project.connections.filter(connection => nodeIds.has(connection.from) && nodeIds.has(connection.to)),
    };
}

/** Returns the nested execution graph for one sequence container. */
export function getContainerExecutionProject(project: EtlProject, containerId: string): EtlProject {
    const nodes = getContainerMembers(project, containerId).map(node => ({ ...node, containerId: undefined }));
    const nodeIds = new Set(nodes.map(node => node.id));
    return {
        name: `Container: ${project.nodes.find(node => node.id === containerId)?.name || containerId}`,
        version: ETL_PROJECT_FORMAT_VERSION,
        nodes,
        connections: project.connections.filter(connection => nodeIds.has(connection.from) && nodeIds.has(connection.to)),
    };
}

export function moveNodesToContainer(
    project: EtlProject,
    containerId: string,
    positions: readonly PositionedNode[],
): EtlProject {
    const container = project.nodes.find(node => node.id === containerId);
    if (!isContainerNode(container)) {
        throw new Error('Target container was not found');
    }

    const positionById = new Map(positions.map(item => [item.id, item.position]));
    if (positionById.size === 0) return project;

    const nodes = project.nodes.map(node => {
        const position = positionById.get(node.id);
        if (!position) return node;
        if (node.id === containerId || node.type === 'container') {
            throw new Error('Containers cannot be nested');
        }
        return { ...node, containerId, position: { ...position } };
    });
    return reconcileContainerBoundaries({ ...project, nodes });
}

export function removeNodesFromContainer(
    project: EtlProject,
    positions: readonly PositionedNode[],
): EtlProject {
    const positionById = new Map(positions.map(item => [item.id, item.position]));
    if (positionById.size === 0) return project;

    const nodes = project.nodes.map(node => {
        const position = positionById.get(node.id);
        if (!position) return node;
        if (!node.containerId) {
            throw new Error(`Task '${node.name}' is not inside a container`);
        }
        return { ...node, containerId: undefined, position: { ...position } };
    });
    return reconcileContainerBoundaries({ ...project, nodes });
}
