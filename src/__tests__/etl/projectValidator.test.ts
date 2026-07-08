/**
 * Unit tests for etl/utils/projectValidator.ts
 * Tests ProjectValidator class for ETL project validation
 */

import {
  ProjectValidator,
  projectValidator,
} from "../../etl/utils/projectValidator";
import {
  EtlProject,
  EtlNode,
  EtlConnection,
  EtlNodeConfig,
} from "../../etl/etlTypes";

function createValidNode(overrides: Partial<EtlNode> = {}): EtlNode {
  const defaultConfig: EtlNodeConfig = { type: "sql", query: "SELECT 1" };
  return {
    id: "node-1",
    type: "sql",
    name: "Test Node",
    position: { x: 100, y: 100 },
    config: defaultConfig,
    ...overrides,
  };
}

function createValidConnection(
  overrides: Partial<EtlConnection> = {},
): EtlConnection {
  return {
    id: "conn-1",
    from: "node-1",
    to: "node-2",
    ...overrides,
  };
}

function createValidProject(overrides: Partial<EtlProject> = {}): EtlProject {
  return {
    name: "Test Project",
    version: "1.0.0",
    nodes: [
      createValidNode({ id: "node-1" }),
      createValidNode({ id: "node-2" }),
    ],
    connections: [],
    ...overrides,
  };
}

describe("ProjectValidator", () => {
  let validator: ProjectValidator;

  beforeEach(() => {
    validator = new ProjectValidator();
  });

  describe("validateProject", () => {
    it("should return valid for correct project", () => {
      const project = createValidProject();
      const result = validator.validateProject(project);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should error when project name is missing", () => {
      const project = createValidProject({ name: "" });
      const result = validator.validateProject(project);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Project name is required");
    });

    it("should error when project version is missing", () => {
      const project = createValidProject({ version: "" });
      const result = validator.validateProject(project);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Project version is required");
    });

    it("should error when nodes is not an array", () => {
      const project = createValidProject({
        nodes: "not-array" as unknown as EtlNode[],
      });
      const result = validator.validateProject(project);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Nodes must be an array");
    });

    it("should error when connections is not an array", () => {
      const project = createValidProject({
        connections: "not-array" as unknown as EtlConnection[],
      });
      const result = validator.validateProject(project);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Connections must be an array");
    });

    it("should handle undefined nodes", () => {
      const project = createValidProject({
        nodes: undefined as unknown as EtlNode[],
      });
      const result = validator.validateProject(project);

      expect(result.errors).toContain("Nodes must be an array");
    });

    it("should handle undefined connections", () => {
      const project = createValidProject({
        connections: undefined as unknown as EtlConnection[],
      });
      const result = validator.validateProject(project);

      expect(result.errors).toContain("Connections must be an array");
    });

    it("should collect multiple errors", () => {
      const project: EtlProject = {
        name: "",
        version: "",
        nodes: "invalid" as unknown as EtlNode[],
        connections: "invalid" as unknown as EtlConnection[],
      };
      const result = validator.validateProject(project);

      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("validateNodes", () => {
    it("should return no errors for valid nodes", () => {
      const nodes = [
        createValidNode({ id: "node-1" }),
        createValidNode({ id: "node-2" }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should error when node ID is missing", () => {
      const nodes = [createValidNode({ id: "" })];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node missing ID");
    });

    it("should error when node ID is undefined", () => {
      const nodes = [createValidNode({ id: undefined as unknown as string })];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node missing ID");
    });

    it("should error on duplicate node IDs", () => {
      const nodes = [
        createValidNode({ id: "duplicate" }),
        createValidNode({ id: "duplicate" }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Duplicate node ID: duplicate");
    });

    it("should error when node type is missing", () => {
      const nodes = [
        createValidNode({ id: "node-1", type: "" as EtlNode["type"] }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node node-1 missing type");
    });

    it("should warn when node name is missing", () => {
      const nodes = [createValidNode({ id: "node-1", name: "" })];
      const result = validator.validateNodes(nodes);

      expect(result.warnings).toContain("Node node-1 has no name");
    });

    it("should error when position is missing", () => {
      const nodes = [
        createValidNode({
          id: "node-1",
          position: undefined as unknown as { x: number; y: number },
        }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node node-1 has invalid position");
    });

    it("should error when position.x is not a number", () => {
      const nodes = [
        createValidNode({
          id: "node-1",
          position: { x: "100" as unknown as number, y: 100 },
        }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node node-1 has invalid position");
    });

    it("should error when position.y is not a number", () => {
      const nodes = [
        createValidNode({
          id: "node-1",
          position: { x: 100, y: "100" as unknown as number },
        }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node node-1 has invalid position");
    });

    it("should error when config is missing", () => {
      const nodes = [
        createValidNode({
          id: "node-1",
          config: undefined as unknown as EtlNodeConfig,
        }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toContain("Node node-1 has no configuration");
    });

    it("should skip further validation for node without ID", () => {
      const nodes = [
        createValidNode({ id: "" }),
        createValidNode({ id: "node-2" }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors).toHaveLength(1);
      expect(result.errors).toContain("Node missing ID");
    });

    it("should handle empty nodes array", () => {
      const result = validator.validateNodes([]);
      expect(result.errors).toHaveLength(0);
    });

    it("should collect multiple errors per node", () => {
      const nodes = [
        createValidNode({
          id: "node-1",
          type: "" as EtlNode["type"],
          name: "",
          position: undefined as unknown as { x: number; y: number },
          config: undefined as unknown as EtlNodeConfig,
        }),
      ];
      const result = validator.validateNodes(nodes);

      expect(result.errors.length).toBeGreaterThan(1);
    });
  });

  describe("validateConnections", () => {
    it("should return no errors for valid connections", () => {
      const connections = [createValidConnection()];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should error when connection ID is missing", () => {
      const connections = [createValidConnection({ id: "" })];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toContain("Connection missing ID");
    });

    it("should error when from node does not exist", () => {
      const connections = [createValidConnection({ from: "nonexistent" })];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toContain(
        "Connection conn-1 has invalid 'from' node: nonexistent",
      );
    });

    it("should error when to node does not exist", () => {
      const connections = [createValidConnection({ to: "nonexistent" })];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toContain(
        "Connection conn-1 has invalid 'to' node: nonexistent",
      );
    });

    it("should error on self-connection", () => {
      const connections = [
        createValidConnection({ from: "node-1", to: "node-1" }),
      ];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toContain(
        "Connection conn-1 cannot connect node to itself",
      );
    });

    it("should warn on duplicate connection", () => {
      const connections = [
        createValidConnection({ id: "conn-1", from: "node-1", to: "node-2" }),
        createValidConnection({ id: "conn-2", from: "node-1", to: "node-2" }),
      ];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.warnings).toContain(
        "Duplicate connection from node-1 to node-2",
      );
    });

    it("should skip further validation for connection without ID", () => {
      const connections = [createValidConnection({ id: "" })];
      const nodeIds = new Set(["node-1", "node-2"]);
      const result = validator.validateConnections(connections, nodeIds);

      expect(result.errors).toHaveLength(1);
    });

    it("should handle empty connections array", () => {
      const nodeIds = new Set(["node-1"]);
      const result = validator.validateConnections([], nodeIds);

      expect(result.errors).toHaveLength(0);
    });

    it("should handle empty nodeIds set", () => {
      const connections = [createValidConnection()];
      const result = validator.validateConnections(connections, new Set());

      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("detectCycles", () => {
    it("should return no errors for acyclic graph", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [
          createValidNode({ id: "a" }),
          createValidNode({ id: "b" }),
          createValidNode({ id: "c" }),
        ],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "b", to: "c" },
        ],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toHaveLength(0);
    });

    it("should detect simple cycle (a -> b -> a)", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [createValidNode({ id: "a" }), createValidNode({ id: "b" })],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "b", to: "a" },
        ],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toContain("Project contains circular dependencies");
    });

    it("should detect self-cycle", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [createValidNode({ id: "a" })],
        connections: [{ id: "c1", from: "a", to: "a" }],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toContain("Project contains circular dependencies");
    });

    it("should detect longer cycle", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [
          createValidNode({ id: "a" }),
          createValidNode({ id: "b" }),
          createValidNode({ id: "c" }),
          createValidNode({ id: "d" }),
        ],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "b", to: "c" },
          { id: "c3", from: "c", to: "d" },
          { id: "c4", from: "d", to: "a" },
        ],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toContain("Project contains circular dependencies");
    });

    it("should handle disconnected components without cycles", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [
          createValidNode({ id: "a" }),
          createValidNode({ id: "b" }),
          createValidNode({ id: "c" }),
          createValidNode({ id: "d" }),
        ],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "c", to: "d" },
        ],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toHaveLength(0);
    });

    it("should handle empty nodes and connections", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [],
        connections: [],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toHaveLength(0);
    });

    it("should handle nodes without connections", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [createValidNode({ id: "a" }), createValidNode({ id: "b" })],
        connections: [],
      };
      const errors = validator.detectCycles(project);

      expect(errors).toHaveLength(0);
    });
  });

  describe("getTopologicalOrder", () => {
    it("should return correct order for simple chain", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [
          createValidNode({ id: "a" }),
          createValidNode({ id: "b" }),
          createValidNode({ id: "c" }),
        ],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "b", to: "c" },
        ],
      };
      const order = validator.getTopologicalOrder(project);

      expect(order).not.toBeNull();
      expect(order!.indexOf("a")).toBeLessThan(order!.indexOf("b"));
      expect(order!.indexOf("b")).toBeLessThan(order!.indexOf("c"));
    });

    it("should return null for cyclic graph", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [createValidNode({ id: "a" }), createValidNode({ id: "b" })],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "b", to: "a" },
        ],
      };
      const order = validator.getTopologicalOrder(project);

      expect(order).toBeNull();
    });

    it("should handle nodes without connections", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [createValidNode({ id: "a" }), createValidNode({ id: "b" })],
        connections: [],
      };
      const order = validator.getTopologicalOrder(project);

      expect(order).not.toBeNull();
      expect(order).toHaveLength(2);
      expect(order).toContain("a");
      expect(order).toContain("b");
    });

    it("should handle diamond dependency pattern", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [
          createValidNode({ id: "a" }),
          createValidNode({ id: "b" }),
          createValidNode({ id: "c" }),
          createValidNode({ id: "d" }),
        ],
        connections: [
          { id: "c1", from: "a", to: "b" },
          { id: "c2", from: "a", to: "c" },
          { id: "c3", from: "b", to: "d" },
          { id: "c4", from: "c", to: "d" },
        ],
      };
      const order = validator.getTopologicalOrder(project);

      expect(order).not.toBeNull();
      expect(order!.indexOf("a")).toBeLessThan(order!.indexOf("b"));
      expect(order!.indexOf("a")).toBeLessThan(order!.indexOf("c"));
      expect(order!.indexOf("b")).toBeLessThan(order!.indexOf("d"));
      expect(order!.indexOf("c")).toBeLessThan(order!.indexOf("d"));
    });

    it("should handle empty project", () => {
      const project: EtlProject = {
        name: "Test",
        version: "1.0",
        nodes: [],
        connections: [],
      };
      const order = validator.getTopologicalOrder(project);

      expect(order).toEqual([]);
    });
  });
});

describe("projectValidator singleton", () => {
  it("should be an instance of ProjectValidator", () => {
    expect(projectValidator).toBeInstanceOf(ProjectValidator);
  });

  it("should validate a project", () => {
    const project = createValidProject();
    const result = projectValidator.validateProject(project);

    expect(result.isValid).toBe(true);
  });
});
