using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class UnknownFieldPreservationTests
{
    [Fact]
    public async Task SaveRequest_PreservesUnknownTopLevelKeys()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "yamlet-unknown-" + Guid.NewGuid());
        Directory.CreateDirectory(tempDir);
        try
        {
            var path = Path.Combine(tempDir, "request.yaml");
            await File.WriteAllTextAsync(path, """
                $kind: http-request
                name: Existing
                method: GET
                url: https://example.com
                tests:
                  - type: http
                    code: pm.test('kept', () => {});
                """);

            var yaml = new YamlSerializationService();
            var service = new RequestFileService(yaml);
            var request = await service.LoadRequestAsync(path);
            request.Name = "Updated";

            await service.SaveRequestAsync(request);

            var saved = await File.ReadAllTextAsync(path);
            Assert.Contains("$kind", saved);
            Assert.Contains("tests:", saved);
            Assert.Contains("Updated", saved);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { /* best effort */ }
        }
    }
}
